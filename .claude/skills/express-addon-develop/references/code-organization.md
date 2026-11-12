# Code organization

Use the project's existing framework, directory conventions, and build entry points. Before coding, identify which files will own rendering, feature behavior, and calls to the outside world. Extend existing modules where they fit.

- Keep the panel entry point and root component focused on initialization, layout, and composing features. Give meaningful sections their own components when they have their own controls or interactions. Keep local UI state with the section that uses it. Lift shared state only to the nearest owner.
- Put domain logic such as validation, encoding, and calculations in named modules with explicit inputs and results. Keep it independent of UI state, Adobe SDK objects, and the DOM where possible.
- Isolate side effects such as Express document edits, file loading, export, and network requests in feature modules or adapters. Keep iframe-only APIs in the panel runtime and document sandbox APIs in the sandbox. Preserve the template's entry points and pass data across the runtime boundary through the supported bridge.
- Name files and functions for their purpose. Share types and constants where their meaning is shared. Keep error handling and cleanup close to the operation that owns them, and give the UI an actionable error to display.

Split files when responsibilities can be named and changed independently. A small feature can live in one focused module. A panel with several workflows needs separate modules for the parts it owns. Avoid line-count gates, files that only forward calls, and broad reorganizations of existing add-ons.

For a QR add-on, the root component can compose content, style, and preview sections. QR encoding and rendering belong in feature code. Logo decoding and resizing, image export, and inserting into Express belong with their respective operations. The panel can then own loading and error messages without implementing all those operations itself.

Before `record`, review the changed source. If the same component renders several independent sections and also implements feature calculations or I/O, extract those responsibilities. Verify the build still includes each module and that the main user action and an expected error case still work.
