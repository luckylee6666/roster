# Structured clone fallback

Unmodified ESM serializer, deserializer and type constants from
[`@ungap/structured-clone` 1.4.0](https://github.com/ungap/structured-clone/tree/v1.4.0),
distributed under the adjacent ISC license. The exact dependency is pinned in
`package.json` and the lockfile; regression tests check these files against it.

`src/webkit-compat.js` installs the fallback only when the OS WebKit does not
provide `structuredClone`. It is used by xterm to copy mode flags. This fallback
does not implement transferable detachment or every browser-native object type.
