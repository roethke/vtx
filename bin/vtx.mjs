#!/usr/bin/env node
// Node won't strip types for files under node_modules, so load the source through tsx.
import { register } from 'tsx/esm/api'
register()
await import('../src/vtx.ts')
