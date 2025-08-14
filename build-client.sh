#!/bin/bash
set -e
echo "--- Changing to packages/client directory ---"
cd packages/client
echo "--- Installing dependencies ---"
npm install
echo "--- Building library ---"
npm run build
echo "--- Build complete ---"
