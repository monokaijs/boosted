export type JsonPrimitive = string | number | boolean | null
export type JsonSerializable = JsonPrimitive | JsonSerializable[] | { [key: string]: JsonSerializable }
export type JsonObject = { [key: string]: JsonSerializable }
