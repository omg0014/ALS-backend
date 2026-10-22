import { Router } from 'express'
import { FirmwareBuild, Sketch } from '../models/index.js'
import { ADMIN } from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import { TOOLCHAIN } from '../lib/firmware/index.js'
import { actorOf, logChange } from '../services/changeLog.js'
import { toolchainReady } from '../services/firmware/builder.js'
import { compileBuild } from '../services/firmware/jobs.js'

// The website's code editor: compile your own Arduino program on the server, then upload it over USB.
// Admin only: compiling code on the server is powerful.
const router = Router()

const MAX_CODE = 200_000

// The code is compiled on this server, so it must not pull server files into the build
// (e.g. #include "/etc/passwd" or .incbin would put them into the error log or the binary).
export function checkCodeSafety(code) {
  const problems = []
  code.split('\n').forEach((line, i) => {
    const include = line.match(/^\s*#\s*include\s*[<"]([^>"]*)[>"]/)
    if (include && /[\\/]|\.\./.test(include[1])) problems.push(`Line ${i + 1}: #include may only name a library header, like <WiFi.h>`)
    if (/^\s*#\s*include\s*[^<"\s]/.test(line)) problems.push(`Line ${i + 1}: #include must be written as #include <Name.h>`)
    if (/\.incbin|__has_include_next|#\s*include_next|#\s*import\b|#\s*embed\b/.test(line)) problems.push(`Line ${i + 1}: this directive is not allowed`)
  })
  return problems
}

router.get('/code/info', ADMIN, (req, res) => {
  res.json({
    ready: toolchainReady(),
    boards: { esp32: TOOLCHAIN.esp32.boardName, esp8266: TOOLCHAIN.esp8266.boardName },
    libraries: TOOLCHAIN.libraries.map((l) => `${l.name} ${l.version}`),
  })
})

// Compile: returns the build id; poll /builds/:id for the result and the compiler messages.
router.post('/code/compile', ADMIN, async (req, res) => {
  const { board, code, name } = req.body ?? {}
  if (!['esp32', 'esp8266'].includes(board)) throw badRequest('Choose the board: ESP32 or NodeMCU')
  if (typeof code !== 'string' || !code.trim()) throw badRequest('There is no code to compile')
  if (code.length > MAX_CODE) throw badRequest('The program is too long')
  if (!/\bvoid\s+setup\s*\(/.test(code) || !/\bvoid\s+loop\s*\(/.test(code)) throw badRequest('An Arduino program needs both setup() and loop()')
  const problems = checkCodeSafety(code)
  if (problems.length) throw badRequest('This code cannot be compiled here', problems)
  if (!toolchainReady()) throw badRequest('The build toolchain is not installed on the server (npm run toolchain:install)')

  const build = await FirmwareBuild.create({
    kind: 'custom',
    sketch: String(name ?? 'my_program').slice(0, 80),
    version: 'custom',
    profileCode: board === 'esp32' ? 'ESP32' : 'NodeMCU',
    createdBy: actorOf(req),
  })
  compileBuild(build, board, [{ path: 'sketch/sketch.ino', content: code }]).catch((err) => console.error('[code]', err.message))
  res.status(202).json({ _id: build._id, espModel: board })
})

// ---- Saved programs ----

router.get('/sketches', ADMIN, async (req, res) => {
  res.json(await Sketch.find({}, 'name board updatedAt updatedBy').sort({ updatedAt: -1 }).lean())
})

router.get('/sketches/:id', ADMIN, async (req, res) => {
  const sketch = await Sketch.findById(req.params.id).lean()
  if (!sketch) throw notFound('Program not found')
  res.json(sketch)
})

router.post('/sketches', ADMIN, async (req, res) => {
  const { name, board, code } = req.body ?? {}
  const sketch = await Sketch.create({ name, board, code, updatedBy: actorOf(req) })
  await logChange(req, 'sketch', 'create', null, { _id: sketch._id, name: sketch.name, board: sketch.board })
  res.status(201).json(sketch)
})

router.put('/sketches/:id', ADMIN, async (req, res) => {
  const sketch = await Sketch.findById(req.params.id)
  if (!sketch) throw notFound('Program not found')
  for (const k of ['name', 'board', 'code']) if (req.body?.[k] !== undefined) sketch[k] = req.body[k]
  sketch.updatedBy = actorOf(req)
  await sketch.save()
  res.json(sketch)
})

router.delete('/sketches/:id', ADMIN, async (req, res) => {
  const sketch = await Sketch.findByIdAndDelete(req.params.id)
  if (!sketch) throw notFound('Program not found')
  await logChange(req, 'sketch', 'delete', { _id: sketch._id, name: sketch.name }, null)
  res.json({ ok: true })
})

export default router
