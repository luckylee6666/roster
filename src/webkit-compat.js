import { deserialize } from './vendor/structured-clone/deserialize.js';
import { serialize } from './vendor/structured-clone/serialize.js';

function relativeIndex(index, length) {
  // Unary + implements ToNumber (unlike Number(), it rejects BigInt).
  const number = +index;
  const integer = Number.isNaN(number) ? 0 : Math.trunc(number);
  return integer < 0 ? length + integer : integer;
}

function defineMissing(target, key, value) {
  if (typeof target[key] !== 'function') {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
}

// Tauri uses the OS WebKit, not a bundled Chromium. Install before opening xterm
// or rendering Marked output; preserve native implementations on newer systems.
export function installWebkitCompatibility(root = globalThis) {
  defineMissing(root.String.prototype, 'at', function at(index) {
    if (this == null || typeof this === 'symbol') throw new TypeError('Invalid String receiver');
    const text = String(this);
    const position = relativeIndex(index, text.length);
    return position >= 0 && position < text.length ? text.charAt(position) : undefined;
  });
  defineMissing(root.Array.prototype, 'at', function at(index) {
    if (this == null) throw new TypeError('Invalid Array receiver');
    const object = Object(this);
    const length = Math.min(Math.max(Math.trunc(+object.length) || 0, 0), Number.MAX_SAFE_INTEGER);
    const position = relativeIndex(index, length);
    return position >= 0 && position < length ? object[position] : undefined;
  });
  // xterm clones its mode flags, including own properties valued undefined.
  // Use the maintained structured-clone implementation, not JSON round-tripping.
  // Like the upstream fallback, transfer lists are not supported/detached.
  defineMissing(root, 'structuredClone', value => deserialize(serialize(value)));
  defineMissing(root, 'queueMicrotask', function queueMicrotask(callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected a function');
    root.Promise.resolve().then(callback).catch(error => {
      root.setTimeout(() => { throw error; }, 0);
    });
  });
}

installWebkitCompatibility();
