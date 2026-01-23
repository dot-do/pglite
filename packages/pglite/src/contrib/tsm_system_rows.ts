import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterfaceBase,
} from '../interface'

const setup = async (_pg: PGliteInterfaceBase, _emscriptenOpts: any) => {
  return {
    bundlePath: new URL(
      '../../release/tsm_system_rows.tar.gz',
      import.meta.url,
    ),
  } satisfies ExtensionSetupResult
}

export const tsm_system_rows = {
  name: 'tsm_system_rows',
  setup,
} satisfies Extension
