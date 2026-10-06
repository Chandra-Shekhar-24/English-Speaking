// scripts/test-otp-flow.js
// Complete automated test of OTP lifecycle, verification, expiration, wrong OTP, and admin status
const auth = require('../auth');
const { query } = require('../db/pool');
const mailer = require('../mailer');

async function runTests() {
  console.log('🧪 ========================================================');
  console.log('🧪 STARTING COMPREHENSIVE OTP & REGISTRATION FLOW VERIFICATION');
  console.log('🧪 ========================================================\n');

  const testEmail = `render_test_${Date.now()}@example.com`;
  const testPassword = 'SecurePassword123!';
  const testName = 'Render Production Tester';

  // 1. REGISTRATION
  console.log(`[Step 1] Registering user: ${testEmail}...`);
  const signupRes = await auth.signup({
    email: testEmail,
    password: testPassword,
    displayName: testName
  }, 'https://english-speaking-g7dn.onrender.com');

  if (!signupRes.userCode || !signupRes.needsVerification) {
    throw new Error('Step 1 FAILED: Signup response did not return userCode or needsVerification');
  }
  const userCode = signupRes.userCode;
  console.log(`✅ [Step 1 PASSED] User registered with ID #${userCode}, status: Pending OTP Verification.`);

  // 2. CHECK DATABASE STORAGE & METADATA
  console.log('\n[Step 2] Verifying database records for user and email_verifications...');
  const userInDb = await query('SELECT * FROM users WHERE email = $1', [testEmail]);
  if (!userInDb.rows || !userInDb.rows.length) {
    throw new Error('Step 2 FAILED: User row not found in database');
  }
  const userRow = userInDb.rows[0];
  if (userRow.is_verified !== false) {
    throw new Error(`Step 2 FAILED: Expected is_verified to be false initially, got: ${userRow.is_verified}`);
  }

  const verInDb = await query('SELECT * FROM email_verifications WHERE user_id = $1', [userRow.id]);
  if (!verInDb.rows || !verInDb.rows.length) {
    throw new Error('Step 2 FAILED: email_verifications row not found');
  }
  const verRow = verInDb.rows[0];
  const realOtp = verRow.otp_code;
  if (!realOtp || realOtp.length !== 6) {
    throw new Error(`Step 2 FAILED: Invalid OTP stored in database: ${realOtp}`);
  }
  const expiresAt = new Date(verRow.expires_at).getTime();
  if (expiresAt <= Date.now()) {
    throw new Error('Step 2 FAILED: OTP expiry is in the past');
  }
  console.log(`✅ [Step 2 PASSED] Database record verified. User ID #${userCode}, is_verified = false, 6-digit OTP = ${realOtp}, Expires in: ${Math.round((expiresAt - Date.now()) / (60 * 1000))} minutes.`);

  // 3. TEST WRONG OTP
  console.log('\n[Step 3] Testing WRONG OTP verification (e.g. 000000)...');
  try {
    await auth.verifyOtp({ email: testEmail, otp: '000000' });
    throw new Error('Step 3 FAILED: Wrong OTP was unexpectedly accepted!');
  } catch (err) {
    if (err.status === 400 && err.message.includes('Invalid or expired')) {
      console.log(`✅ [Step 3 PASSED] Wrong OTP correctly rejected with message: "${err.message}".`);
    } else {
      throw new Error(`Step 3 FAILED: Unexpected error for wrong OTP: ${err.message}`);
    }
  }

  // 4. TEST EXPIRED OTP
  console.log('\n[Step 4] Testing EXPIRED OTP rejection...');
  // Artificially expire the OTP in DB for this test
  await query('UPDATE email_verifications SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [verRow.id]);
  try {
    await auth.verifyOtp({ email: testEmail, otp: realOtp });
    throw new Error('Step 4 FAILED: Expired OTP was unexpectedly accepted!');
  } catch (err) {
    if (err.status === 400 && err.message.includes('expired')) {
      console.log(`✅ [Step 4 PASSED] Expired OTP correctly rejected with message: "${err.message}".`);
    } else {
      throw new Error(`Step 4 FAILED: Unexpected error for expired OTP: ${err.message}`);
    }
  }

  // 5. TEST RESEND OTP
  console.log('\n[Step 5] Testing RESEND OTP functionality...');
  const resendRes = await auth.resendVerificationEmail(testEmail, 'https://english-speaking-g7dn.onrender.com');
  if (!resendRes.ok) {
    throw new Error('Step 5 FAILED: Resend OTP did not return ok: true');
  }
  const freshVerInDb = await query('SELECT * FROM email_verifications WHERE user_id = $1 AND verified_at IS NULL ORDER BY created_at DESC', [userRow.id]);
  const freshVerRow = freshVerInDb.rows[0];
  const freshOtp = freshVerRow.otp_code;
  if (!freshOtp || freshOtp === '000000' || freshOtp.length !== 6) {
    throw new Error(`Step 5 FAILED: Invalid fresh OTP generated: ${freshOtp}`);
  }
  console.log(`✅ [Step 5 PASSED] Resend OTP succeeded. Fresh OTP generated: ${freshOtp}, active for: ${testEmail}.`);

  // 6. TEST CORRECT OTP VERIFICATION
  console.log(`\n[Step 6] Testing CORRECT OTP verification with fresh OTP (${freshOtp})...`);
  const verifyRes = await auth.verifyOtp({ email: testEmail, otp: freshOtp }, { ip: '127.0.0.1', userAgent: 'test-runner' });
  if (!verifyRes.user || !verifyRes.user.isVerified || !verifyRes.token) {
    throw new Error('Step 6 FAILED: Verification response missing isVerified: true or session token');
  }
  console.log(`✅ [Step 6 PASSED] OTP verified! Account activated: isVerified = ${verifyRes.user.isVerified}, Session token issued.`);

  // 7. CONFIRM DATABASE IS_VERIFIED STATUS
  console.log('\n[Step 7] Confirming database user row status after verification...');
  const verifiedUserInDb = await query('SELECT * FROM users WHERE email = $1', [testEmail]);
  if (!verifiedUserInDb.rows[0].is_verified) {
    throw new Error('Step 7 FAILED: User row is_verified is still false in database');
  }
  console.log(`✅ [Step 7 PASSED] Database row confirmed: is_verified = TRUE.`);

  // 8. TEST LOGIN AFTER ACTIVATION
  console.log('\n[Step 8] Testing login after account activation...');
  const loginRes = await auth.login({ email: testEmail, password: testPassword }, { ip: '127.0.0.1', userAgent: 'test-runner' });
  if (!loginRes.user || !loginRes.user.isVerified || !loginRes.token) {
    throw new Error('Step 8 FAILED: Login after activation failed');
  }
  console.log(`✅ [Step 8 PASSED] Login succeeded immediately for active user #${loginRes.user.userCode} (${loginRes.user.displayName}).`);

  // 9. TEST RE-VERIFYING ALREADY VERIFIED OTP
  console.log('\n[Step 9] Testing re-submitting OTP for already verified account...');
  const reVerifyRes = await auth.verifyOtp({ email: testEmail, otp: freshOtp });
  if (!reVerifyRes.user.isVerified) {
    throw new Error('Step 9 FAILED: Re-verify did not recognize already verified account');
  }
  console.log(`✅ [Step 9 PASSED] Already verified account handled gracefully.`);

  console.log('\n🎉 ========================================================');
  console.log('🎉 ALL 9 TEST STEPS PASSED WITH 100% SUCCESS!');
  console.log('🎉 ========================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ TEST RUNNER FAILED:', err);
  process.exit(1);
});
