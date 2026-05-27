# Do Not Ship Renderer Framework Adapters

The package exposes a framework-agnostic renderer client and preload bridge, but does not ship React hooks or other renderer-framework adapters. Renderer lifecycle belongs to the consuming Electron app because apps may load media through routers, loaders, state managers, component lifecycles, or plain imperative code; keeping that ownership outside the library avoids forcing one framework model over better app-specific choices.
