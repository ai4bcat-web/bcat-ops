/**
 * An in-memory stand-in for the KMS client, for tests only. It "encrypts" by wrapping the plaintext with its
 * encryption context so a Decrypt with a different context (another carrier, another field) fails the way the
 * real service does. It is not cryptography and never leaves a test.
 */
export function fakeKms() {
  const sent: { name: string; context: Record<string, string> }[] = []
  return {
    sent,
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name
      const context = (command.input.EncryptionContext ?? {}) as Record<string, string>
      sent.push({ name, context })
      if (name === 'EncryptCommand') {
        const plain = Buffer.from(command.input.Plaintext as Uint8Array).toString('utf8')
        const blob = Buffer.from(JSON.stringify({ ctx: context, data: Buffer.from(plain).toString('base64').split('').reverse().join('') }))
        return { CiphertextBlob: new Uint8Array(blob), KeyId: 'fake-key' }
      }
      if (name === 'DecryptCommand') {
        const wrapped = JSON.parse(Buffer.from(command.input.CiphertextBlob as Uint8Array).toString('utf8')) as { ctx: Record<string, string>; data: string }
        if (JSON.stringify(wrapped.ctx) !== JSON.stringify(context)) throw new Error('InvalidCiphertextException')
        const plain = Buffer.from(wrapped.data.split('').reverse().join(''), 'base64')
        return { Plaintext: new Uint8Array(plain) }
      }
      throw new Error(`fakeKms: unsupported ${name}`)
    },
  }
}
