#!/usr/bin/env node
'use strict';

// The local hub's entry point.
//   hub.js mcp  [--agent <name>]   MCP server over stdio (add this to any agent app)
//   hub.js hook  --agent <name>    lifecycle hook (SessionStart, UserPromptSubmit, Stop)
//   hub.js who                     list registered sessions (for people)
// The hub folder is ~/.whatsmyagentdoing/hub, or $WMAD_HUB_DIR.

const { HubStore, address } = require('../src/hub/store');
const { Titles } = require('../src/hub/titles');
const store = () => new HubStore({ titles: new Titles() });

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null; };

if (cmd === 'mcp') {
  const { HubServer } = require('../src/hub/mcp');
  new HubServer({ store: store(), agent: opt('agent') }).serve();
} else if (cmd === 'hook') {
  const { handle } = require('../src/hub/hook');
  const agent = opt('agent');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let out = '';
    try { if (agent) out = handle(store(), agent, input); } catch {}
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
  });
} else if (cmd === 'who') {
  const rows = store().sessions();
  if (!rows.length) console.log('허브에 등록된 세션이 없습니다.');
  for (const r of rows) console.log(`${address(r)}\t${r.title || '-'}\t${r.project ? r.project.name : '-'}\t${r.status ? r.status.state : '-'}`);
} else {
  console.error('usage: hub.js mcp [--agent <name>] | hook --agent <name> | who');
  process.exit(1);
}
