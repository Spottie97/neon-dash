#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/reinhardt/Desktop/Fun Games"
exec node /opt/homebrew/lib/node_modules/npm/bin/npx-cli.js serve . --no-clipboard
