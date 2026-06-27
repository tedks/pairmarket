declare const pairmarketBrand: unique symbol;

export type Brand<T, Name> = T & {
  readonly [pairmarketBrand]: Name;
};

export type BrandName<T> = T extends Brand<unknown, infer Name> ? Name : never;
