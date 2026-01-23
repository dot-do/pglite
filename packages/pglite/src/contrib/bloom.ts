import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/bloom.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const bloom = {
  name: 'bloom',
  setup,
} satisfies Extension
