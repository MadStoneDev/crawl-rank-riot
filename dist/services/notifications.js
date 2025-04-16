"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendCompletionEmail = sendCompletionEmail;
const axios_1 = __importDefault(require("axios"));
const logger_1 = __importDefault(require("../utils/logger"));
const config_1 = __importDefault(require("../config"));
async function sendCompletionEmail(email, projectName, scanId, issueCount) {
    try {
        const emailData = {
            recipient: email,
            subject: `Scan completed for ${projectName}`,
            content: `
        <h1>Your website scan is complete!</h1>
        <p>The scan for project "${projectName}" has finished.</p>
        <p>We found ${issueCount} issues that may need your attention.</p>
        <p><a href="https://rankriot.app/dashboard/projects/scans/${scanId}">View detailed scan results</a></p>
      `,
        };
        const response = await axios_1.default.post("https://api.mailersend.com/v1/email", {
            from: {
                email: "notifications@rankriot.app",
                name: "RankRiot",
            },
            to: [
                {
                    email: emailData.recipient,
                },
            ],
            subject: emailData.subject,
            html: emailData.content,
        }, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config_1.default.mailersend.apiKey}`,
            },
        });
        logger_1.default.info(`Sent completion email to ${email} for scan ${scanId}`);
        return true;
    }
    catch (error) {
        logger_1.default.error(`Failed to send completion email: ${error}`);
        return false;
    }
}
