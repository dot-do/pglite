import { type Results as BaseResults } from '@dotdo/pglite'

// When using rowMode: 'array', each row is an array of values
export type Results = BaseResults<unknown[]>

export interface Response {
  query: string
  text?: string
  error?: string
  results?: Results[]
  time: number
}
