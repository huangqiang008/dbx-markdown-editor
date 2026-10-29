
export declare global {
    interface Window {
        dbxPlugin?: {
            ready?: Promise<unknown>
            context?: { theme?: { locale?: string } }
            capabilities?: { storage?: boolean }
            storage?: { get: (key: string) => Promise<any>; set: (key: string, value: unknown) => Promise<void> }
            invoke: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<any>
        }
        basePath: string
        actualTheme: string
    }
}
