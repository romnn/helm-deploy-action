import * as assert from 'assert'

function replaceProtocol(href: string, protocol: string): string {
  return href.replace(/^[^:]+:/, protocol)
}

function fixReplaceURLProtocol<T extends URL, P extends string = string>(
  url: T,
  oldProtocol: string,
  newProtocol: P
): asserts url is T & {
  protocol: P
} {
  if (isSameProtocol(url.protocol, oldProtocol)) {
    url.href = replaceProtocol(url.href, newProtocol)
    assertProtocolNotEqual(url.protocol, oldProtocol)
  }
}

function isSameProtocol<T extends string>(
  actualProtocol: string,
  expectedProtocol: T
): actualProtocol is T {
  return actualProtocol === expectedProtocol
}

function assertProtocolNotEqual(
  actualProtocol: string,
  expectedProtocol: string
): void {
  assert.notStrictEqual(actualProtocol, expectedProtocol)
}

export function replaceURLProtocol<T extends URL, P extends string = string>(
  url: T,
  protocol: P
): T {
  const old = url.protocol

  if (!isSameProtocol(old, protocol)) {
    url.protocol = protocol
    fixReplaceURLProtocol(url, old, protocol)
  }

  return url
}
