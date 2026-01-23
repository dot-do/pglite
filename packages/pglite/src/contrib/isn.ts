import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/isn.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const isn = {
  name: 'isn',
  setup,
} satisfies Extension
