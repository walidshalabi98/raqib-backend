import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

// GET /api/notifications
router.get('/', authenticate, async (req: Request, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(notifications);
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authenticate, async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { isRead: true },
  });
  res.json({ message: 'Marked as read' });
});

// PATCH /api/notifications/read-all
router.patch('/read-all', authenticate, async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true },
  });
  res.json({ message: 'All notifications marked as read' });
});

export default router;
