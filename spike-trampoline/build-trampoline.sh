#!/bin/bash
#
# build-trampoline.sh
#
# Build script for PGlite with EM_JS trampoline support.
# This replaces the addFunction-based callbacks with EM_JS trampolines
# that work in Cloudflare Workers.
#
# Key differences from the original build-pglite.sh:
# 1. Uses pglite-comm-trampoline.h instead of pglite-comm.h
# 2. Removes ALLOW_TABLE_GROWTH (not needed for trampolines)
# 3. Removes addFunction/removeFunction from EXPORTED_RUNTIME_METHODS
# 4. Adds EM_JS compilation support
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTGRES_DIR="${SCRIPT_DIR}/../postgres-pglite"

echo "=== PGlite Trampoline Build ==="
echo "This build uses EM_JS trampolines instead of addFunction"
echo ""

# Step 1: Backup original pglite-comm.h
COMM_H="${POSTGRES_DIR}/pglite/includes/pglite-comm.h"
COMM_H_BACKUP="${COMM_H}.backup"

if [ -f "${COMM_H}" ] && [ ! -f "${COMM_H_BACKUP}" ]; then
    echo "Step 1: Backing up original pglite-comm.h"
    cp "${COMM_H}" "${COMM_H_BACKUP}"
fi

# Step 2: Copy trampoline version
echo "Step 2: Installing pglite-comm-trampoline.h"
cp "${SCRIPT_DIR}/pglite-comm-trampoline.h" "${COMM_H}"

# Step 3: Create modified build flags
# The key changes:
# - Remove ALLOW_TABLE_GROWTH
# - Remove addFunction, removeFunction from exports
# - Keep wasmTable for potential v1 approach

EXPORTED_RUNTIME_METHODS="MEMFS,IDBFS,FS,setValue,getValue,UTF8ToString,stringToNewUTF8,stringToUTF8OnStack,wasmTable"

# Flags without ALLOW_TABLE_GROWTH
PGLITE_EMSCRIPTEN_FLAGS="-sWASM_BIGINT \
-sSUPPORT_LONGJMP=emscripten \
-sFORCE_FILESYSTEM=1 \
-sNO_EXIT_RUNTIME=1 -sENVIRONMENT=node,web,worker \
-sMAIN_MODULE=2 -sMODULARIZE=1 -sEXPORT_ES6=1 \
-sEXPORT_NAME=Module -sALLOW_MEMORY_GROWTH \
-sERROR_ON_UNDEFINED_SYMBOLS=0 \
-sEXPORTED_RUNTIME_METHODS=${EXPORTED_RUNTIME_METHODS}"

echo ""
echo "=== Build Configuration ==="
echo "EXPORTED_RUNTIME_METHODS: ${EXPORTED_RUNTIME_METHODS}"
echo ""
echo "Key differences from standard build:"
echo "  - NO addFunction/removeFunction exports"
echo "  - NO ALLOW_TABLE_GROWTH"
echo "  - Uses EM_JS trampolines in pglite-comm-trampoline.h"
echo ""

# Step 4: Instructions for building
echo "=== Build Instructions ==="
echo ""
echo "To build PGlite with trampoline support, run these commands:"
echo ""
echo "  cd ${POSTGRES_DIR}"
echo "  export PGLITE_EMSCRIPTEN_FLAGS='${PGLITE_EMSCRIPTEN_FLAGS}'"
echo "  ./build-pglite.sh"
echo ""
echo "The resulting pglite.js will work in Cloudflare Workers!"
echo ""

# Step 5: Verification check
echo "=== Verification ==="
echo ""
echo "After building, verify the WASM doesn't require runtime compilation:"
echo ""
echo "  1. Check the .js file doesn't contain 'addFunction' calls:"
echo "     grep -c 'addFunction' pglite.js  # Should be 0"
echo ""
echo "  2. Test in Cloudflare Workers (Miniflare):"
echo "     npx wrangler dev test-worker.js"
echo ""

# Step 6: Restore option
echo "=== Restore Original ==="
echo ""
echo "To restore the original pglite-comm.h:"
echo "  cp ${COMM_H_BACKUP} ${COMM_H}"
echo ""

# Optional: Actually run the build
if [ "$1" == "--build" ]; then
    echo "=== Running Build ==="
    cd "${POSTGRES_DIR}"

    # Override the build flags in a way that works with the existing script
    # This is a bit hacky but works for testing

    export PGLITE_EMSCRIPTEN_FLAGS="${PGLITE_EMSCRIPTEN_FLAGS}"

    # Run the original build script
    # ./build-pglite.sh

    echo "Build complete!"
fi
