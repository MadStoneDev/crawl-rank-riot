import axios from "axios";
import logger from "../utils/logger";
import config from "../config";

interface EmailData {
  recipient: string;
  subject: string;
  content: string;
}

export async function sendCompletionEmail(
  email: string,
  projectName: string,
  scanId: string,
  issueCount: number,
): Promise<boolean> {
  try {
    const emailData: EmailData = {
      recipient: email,
      subject: `Scan completed for ${projectName}`,
      content: `
        <h1>Your website scan is complete!</h1>
        <p>The scan for project "${projectName}" has finished.</p>
        <p>We found ${issueCount} issues that may need your attention.</p>
        <p><a href="https://rankriot.app/dashboard/projects/scans/${scanId}">View detailed scan results</a></p>
      `,
    };

    const response = await axios.post(
      "https://api.mailersend.com/v1/email",
      {
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
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.mailersend.apiKey}`,
        },
      },
    );

    logger.info(`Sent completion email to ${email} for scan ${scanId}`);
    return true;
  } catch (error) {
    logger.error(`Failed to send completion email: ${error}`);
    return false;
  }
}
