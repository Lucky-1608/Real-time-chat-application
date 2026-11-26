import { Router } from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { registerSchema, loginSchema } from '../utils/validators.js';
import { AppError } from '../middleware/errorHandler.js';
import { signToken } from '../middleware/auth.js';
import { addUserToGeneralRoom } from '../services/roomMigration.js';

const BCRYPT_COST = 10;

export function createAuthRouter({ rateLimiter } = {}) {
  const router = Router();

  if (rateLimiter) {
    router.use(rateLimiter);
  }

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid registration data', 400);
      }

      const { username, password } = parsed.data;
      const usernameLower = username.toLowerCase();

      const existing = await User.findOne({ usernameLower }).lean();
      if (existing) {
        throw new AppError('Username is already taken', 409);
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const user = await User.create({
        username,
        usernameLower,
        passwordHash,
      });

      await addUserToGeneralRoom(user._id);

      const serializedUser = user.toJSON();
      const token = signToken(serializedUser);

      res.status(201).json({
        token,
        user: serializedUser,
      });
    })
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0]?.message || 'Invalid login data', 400);
      }

      const { username, password } = parsed.data;
      const usernameLower = username.toLowerCase();

      const user = await User.findOne({ usernameLower });
      const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;

      // Return an identical error for unknown user and wrong password to prevent username enumeration.
      if (!user || !passwordMatches) {
        throw new AppError('Invalid username or password', 401);
      }

      const serializedUser = user.toJSON();
      const token = signToken(serializedUser);

      res.status(200).json({
        token,
        user: serializedUser,
      });
    })
  );

  return router;
}
