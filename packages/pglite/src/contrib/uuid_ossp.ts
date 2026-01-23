import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/uuid-ossp.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const uuid_ossp = {
  name: 'uuid-ossp',
  setup,
} satisfies Extension
