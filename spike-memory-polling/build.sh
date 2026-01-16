#!/bin/bash
#
# Build script for the memory polling test WASM module
#
# Requirements:
# - Emscripten SDK installed and activated
#   (source /path/to/emsdk/emsdk_env.sh)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building memory polling test WASM module..."

# Check if emcc is available
if ! command -v emcc &> /dev/null; then
    echo "Error: emcc not found. Please install and activate Emscripten SDK."
    echo ""
    echo "Installation:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk"
    echo "  ./emsdk install latest"
    echo "  ./emsdk activate latest"
    echo "  source ./emsdk_env.sh"
    exit 1
fi

echo "Using emcc: $(which emcc)"
emcc --version | head -1

# Build the test WASM module
emcc -O2 \
    -o test-polling.mjs \
    test-wasm.c \
    -sEXPORTED_FUNCTIONS="['_main','_get_input_buffer','_get_output_buffer','_get_control','_get_buffer_size','_reset_buffers','_signal_input_ready','_has_output','_get_output_length','_ack_output','_process_message','_process_multi_row']" \
    -sEXPORTED_RUNTIME_METHODS="['HEAPU8','HEAPU32','HEAP32']" \
    -sNO_EXIT_RUNTIME=1 \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME=TestModule \
    -sENVIRONMENT=node \
    -sALLOW_MEMORY_GROWTH=1

echo ""
echo "Build complete!"
echo "Output files:"
ls -la test-polling.mjs test-polling.wasm 2>/dev/null || true

echo ""
echo "To test, run:"
echo "  npx tsx test-polling.ts"
