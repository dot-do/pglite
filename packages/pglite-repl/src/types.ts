import { type Results as BaseResults } from '@dotdo/pglite'

export type Results = BaseResults<{ [key: string]: unknown }[]>

export interface Response {
  query: string
  text?: string
  error?: string
  results?: Results[]
  time: number
}
