/**
 * Host half of the composer-predict bundle.
 *
 * One same-origin HTTP route the Client half calls to predict the user's next
 * words. Supports a streaming mode (plain text deltas) so the Client can paint
 * the first tokens immediately, and a buffered JSON mode otherwise.
 */

const ROUTE_PATH = '/plugins/dsh-composer-predict/predict'
const MAX_BODY_BYTES = 64 * 1024
const MAX_OUTPUT_TOKENS = 80
const MAX_SUGGESTION_CHARS = 240

const STREAM_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

export const inject = ['llm', 'agentDefaultModel', 'webServer']

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function systemPrompt(locale) {
  if (String(locale).startsWith('zh')) {
    return [
      '你是输入续写助手，只做一件事：预测用户在自己的输入框里、光标之后接下来最可能继续打出的文字，也就是猜测用户的目的。',
      '规则：只输出要接在光标后的“续写”文字；不要重复用户已输入的内容；不要解释、不要加引号、不要加任何前缀；保持与用户一致的语言和语气；尽量短（一般不超过 30 字）；无法合理预测时输出空字符串。',
    ].join('\n')
  }
  return [
    'You predict the words the user is about to type in their own input box, right after the cursor. You only output the continuation.',
    'Rules: output ONLY the continuation to append after the cursor; do not repeat text the user already typed; no explanation, no quotes, no prefix; match the user language and tone; keep it short (usually under 25 words); if you cannot reasonably predict, output an empty string.',
  ].join('\n')
}

function buildUserText(draft, context) {
  if (draft.trim() === '') {
    return [
      '对话上下文（最近的发言）：',
      context,
      '',
      '用户此刻还没有在输入框里打字。请根据上面这段对话，预测用户下一条最可能发送的回复；如果助手刚提出了问题或给出了几个选项，请优先预测用户会选的那个（例如“方案一”“第 2 个”“都行”）。',
      '只输出用户会输入的那一小段文字，不要解释，不要引号。',
    ].join('\n')
  }
  return context
    ? `对话上下文（最近的发言，仅供理解目的）：\n${context}\n\n用户当前正在输入（光标在末尾）：\n${draft}\n\n只输出续写内容。`
    : `用户当前正在输入（光标在末尾）：\n${draft}\n\n只输出续写内容。`
}

async function handle(ctx, req, res) {
  try {
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'method not allowed' }); return }
    // Local-only + explicit client header: blocks cross-site / casual CSRF.
    const remote = req.socket && req.socket.remoteAddress
    if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      send(res, 403, { ok: false, error: 'forbidden' }); return
    }
    if (String(req.headers['x-composer-predict'] || '') !== '1') {
      send(res, 403, { ok: false, error: 'missing client header' }); return
    }
    const reqType = String(req.headers['content-type'] || '')
    if (reqType.indexOf('application/json') === -1) {
      send(res, 415, { ok: false, error: 'unsupported media type' }); return
    }
    const body = await readJson(req)
    const draft = typeof body.draft === 'string' ? body.draft : ''
    const context = typeof body.context === 'string' ? body.context.slice(0, 6000) : ''
    const locale = typeof body.locale === 'string' ? body.locale : 'zh'
    const stream = body.stream === true

    if (draft.trim() === '' && context.trim() === '') {
      if (stream) { res.writeHead(200, STREAM_HEADERS); res.end('') } else send(res, 200, { ok: true, suggestion: '' })
      return
    }

    const selection = ctx.agentDefaultModel.currentSelection()
    if (!selection || !selection.provider || !selection.model) {
      if (stream) { res.writeHead(200, STREAM_HEADERS); res.end('') } else send(res, 200, { ok: false, error: 'no default model configured' })
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    req.on('close', () => controller.abort())
    const options = {
      provider: selection.provider,
      model: selection.model,
      system: systemPrompt(locale),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserText(draft, context) }] }],
      temperature: 0.3,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: controller.signal,
    }

    if (stream) {
      res.writeHead(200, STREAM_HEADERS)
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          if (controller.signal.aborted) break
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
            res.write(chunk.text)
          } else if (chunk && chunk.type === 'finish') {
            const reason = chunk.reason
            if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) break
          }
        }
      } catch (error) {
        /* partial output is acceptable */
      } finally {
        clearTimeout(timer)
        res.end()
      }
      return
    }

    let text = ''
    let usage = null
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk && chunk.type === 'usage') usage = chunk.usage
        else if (chunk && chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
            const message = reason.failure && reason.failure.message ? reason.failure.message : reason.kind
            throw new Error(String(message))
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
    let suggestion = text.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/gu, '').trim()
    if (suggestion.length > MAX_SUGGESTION_CHARS) suggestion = suggestion.slice(0, MAX_SUGGESTION_CHARS)
    send(res, 200, { ok: true, suggestion, usage })
  } catch (error) {
    try {
      if (!res.headersSent) send(res, 200, { ok: false, error: String((error && error.message) || error) })
      else res.end()
    } catch (_error) { /* ignore */ }
  }
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => { void handle(ctx, req, res) },
    }),
    'dsh-composer-predict: predict route',
  )
}
