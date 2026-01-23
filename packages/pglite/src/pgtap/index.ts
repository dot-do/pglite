import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL('../../release/pgtap.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pgtap = {
  name: 'pgtap',
  setup,
} satisfies Extension
