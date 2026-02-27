import type { Transport, ConnectionConfig } from '../../src/transport'

/**
 * Example PubNub transport implementation.
 * Shows how to implement the Transport interface for PubNub pub/sub.
 */
export class PubNubTransport implements Transport {
  private pubnub: any = null
  private channel: string = ''
  private uuid: string = ''
  private messageCallback?: (data: Uint8Array) => void
  private _isConnected: boolean = false

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(
    config: ConnectionConfig & {
      publishKey: string
      subscribeKey: string
    },
  ): Promise<void> {
    if (!config.publishKey || !config.subscribeKey) {
      throw new Error('PubNub requires publishKey and subscribeKey')
    }

    // Generate unique ID for this client
    this.uuid = crypto.randomUUID()
    this.channel = btoa(config.room)

    // @ts-ignore - PubNub global
    this.pubnub = new PubNub({
      publishKey: config.publishKey,
      subscribeKey: config.subscribeKey,
      uuid: this.uuid,
      cipherKey: config.password,
    })

    return new Promise((resolve) => {
      this.pubnub.addListener({
        status: (statusEvent: any) => {
          if (statusEvent.category === 'PNConnectedCategory') {
            this._isConnected = true
            resolve()
          }
        },
        message: (event: any) => {
          // Ignore our own messages
          if (event.publisher === this.uuid) return

          if (this.messageCallback && event.message) {
            // Convert base64 to Uint8Array if needed
            const data =
              typeof event.message === 'string'
                ? this._base64ToUint8(event.message)
                : new Uint8Array(event.message)
            this.messageCallback(data)
          }
        },
      })

      this.pubnub.subscribe({
        channels: [this.channel],
      })
    })
  }

  disconnect(): void {
    if (this.pubnub) {
      this.pubnub.unsubscribeAll()
      this.pubnub = null
    }
    this._isConnected = false
  }

  send(data: Uint8Array): void {
    if (this.pubnub && this._isConnected) {
      this.pubnub.publish({
        channel: this.channel,
        message: this._uint8ToBase64(data),
        storeInHistory: false,
      })
    }
  }

  onMessage(callback: (data: Uint8Array) => void): () => void {
    this.messageCallback = callback
    return () => {
      this.messageCallback = undefined
    }
  }

  private _uint8ToBase64(data: Uint8Array): string {
    return btoa(String.fromCharCode(...data))
  }

  private _base64ToUint8(str: string): Uint8Array {
    return new Uint8Array(
      atob(str)
        .split('')
        .map((c) => c.charCodeAt(0)),
    )
  }
}
