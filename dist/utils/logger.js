"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const winston_1 = __importDefault(require("winston"));
const config_1 = __importDefault(require("../config"));
const logger = winston_1.default.createLogger({
    level: config_1.default.nodeEnv === "production" ? "info" : "debug",
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.printf(({ level, message, timestamp }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })),
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({ filename: "error.log", level: "error" }),
        new winston_1.default.transports.File({ filename: "combined.log" }),
    ],
});
exports.default = logger;
