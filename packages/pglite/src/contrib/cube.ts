import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/cube.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const cube = {
  name: 'cube',
  setup,
} satisfies Extension
