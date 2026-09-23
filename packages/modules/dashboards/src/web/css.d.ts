// react-grid-layout/react-resizable ship their own CSS, imported for side
// effects only (no exports) — this package isn't built by vite, so it has
// no `vite/client` ambient types to recognize that import shape.
declare module "*.css";
