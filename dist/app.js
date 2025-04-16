"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./utils/logger"));
const api_1 = __importDefault(require("./routes/api"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const app = (0, express_1.default)();
// Middleware
app.use(express_1.default.json());
app.use((0, cors_1.default)({
    origin: [
        "https://rankriot.app",
        "http://localhost:3123",
        "https://crawl.rankriot.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
// Simple request logging
app.use((req, res, next) => {
    logger_1.default.info(`${req.method} ${req.url}`);
    next();
});
// Routes
app.use("/api", api_1.default);
app.use("/webhooks", webhooks_1.default);
// Health check endpoint
app.get("/health", (req, res) => {
    res.status(200).send({ status: "ok" });
});
// Error handler
app.use((err, req, res, next) => {
    logger_1.default.error(err.stack);
    res.status(500).send({
        error: "Internal Server Error",
        message: config_1.default.nodeEnv === "development" ? err.message : undefined,
    });
});
exports.default = app;
