import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/pg_walinspect.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pg_walinspect = {
  name: 'pg_walinspect',
  setup,
} satisfies Extension
