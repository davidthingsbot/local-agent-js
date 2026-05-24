#!/usr/bin/env node
import { main } from '../src/agent.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  },
);
