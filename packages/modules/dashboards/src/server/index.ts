export {
    default as dashboardModuleRoutes,
    authorizeEmbed,
    authorizeSignedEmbed,
    type DashboardModuleRouteOptions,
    type SignedEmbedResult,
} from "./routes.js";
export { fetchWidgetData, type WidgetData } from "./chart-query.js";
export { registerChartTypeShape, type ChartShape } from "./chart-shapes.js";
export type { Dashboard, DashboardLayoutItem, Widget, WidgetFilter, HighlightRule } from "./models.js";
