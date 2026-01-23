import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL('../../release/vector.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const vector = {
  name: 'pgvector',
  setup,
} satisfies Extension
