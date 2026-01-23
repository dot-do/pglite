import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL('../../release/pg_buffercache.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const pg_buffercache = {
  name: 'pg_buffercache',
  setup,
} satisfies Extension
