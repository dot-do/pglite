import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/amcheck.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const amcheck = {
  name: 'amcheck',
  setup,
} satisfies Extension
