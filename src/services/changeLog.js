import { ConfigChange } from '../models/index.js'

// Every configuration change is recorded with who, when and what (PRD C5). Rollback is Phase 4.
const strip = (doc) => {
  if (!doc) return null
  const o = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: false }) : { ...doc }
  delete o.passwordHash
  delete o.credentialHash
  delete o.__v
  return o
}

export function actorOf(req) {
  return req?.user ? { kind: 'user', user: req.user._id, name: req.user.name } : { kind: 'system', name: 'system' }
}

export async function logChange(req, entity, action, before, after) {
  const id = (after || before)?._id
  await ConfigChange.create({
    entity,
    entityId: id ? String(id) : undefined,
    action,
    before: strip(before),
    after: strip(after),
    actor: actorOf(req),
  })
}
