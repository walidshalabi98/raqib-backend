import { Resend } from 'resend';
import { env } from '../config/env';

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

export async function sendPasswordResetEmail(email: string, resetToken: string): Promise<void> {
  const resetUrl = `${env.appUrl}/reset-password?token=${resetToken}`;

  if (!resend) {
    console.log(`[DEV] Password reset link for ${email}: ${resetUrl}`);
    return;
  }

  await resend.emails.send({
    from: 'RAQIB <noreply@raqib.momentumlabs.ps>',
    to: email,
    subject: 'Reset Your RAQIB Password',
    html: `
      <h2>Password Reset Request</h2>
      <p>Click the link below to reset your password. This link expires in 1 hour.</p>
      <a href="${resetUrl}">Reset Password</a>
      <p>If you didn't request this, please ignore this email.</p>
    `,
  });
}

export async function sendInviteEmail(email: string, orgName: string, tempPassword: string): Promise<void> {
  const loginUrl = `${env.appUrl}/login`;

  if (!resend) {
    console.log(`[DEV] Invite for ${email}: org=${orgName}, password=${tempPassword}, login=${loginUrl}`);
    return;
  }

  await resend.emails.send({
    from: 'RAQIB <noreply@raqib.momentumlabs.ps>',
    to: email,
    subject: `You've been invited to ${orgName} on RAQIB`,
    html: `
      <h2>Welcome to RAQIB</h2>
      <p>You've been invited to join <strong>${orgName}</strong> on the RAQIB M&E Platform.</p>
      <p>Your temporary password is: <strong>${tempPassword}</strong></p>
      <p>Please log in and change your password immediately.</p>
      <a href="${loginUrl}">Log In to RAQIB</a>
    `,
  });
}
