const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { slugify } = require('transliteration');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CLOUDINARY CONFIG =====
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ===== CLOUDINARY STORAGE FOR MULTER =====
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'bangla-choti',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 400, height: 280, crop: 'fill', quality: 'auto' }]
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// ===== MONGODB CONNECTION =====
// ===== STORY SCHEMA =====
const storySchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, unique: true, sparse: true, index: true },
  author: { type: String, default: 'অজ্ঞাত' },
  content: { type: String, required: true },
  excerpt: { type: String },
  image: { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
  categories: [{ type: String }],
  tags: [{ type: String }],
  views: { type: Number, default: 0 },
  isHot: { type: Boolean, default: false },
  isNew: { type: Boolean, default: true },
  status: { type: String, enum: ['published', 'draft'], default: 'published' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Story = mongoose.model('Story', storySchema);

// ===== CATEGORY SCHEMA =====
const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  icon: { type: String, default: '📖' }
});
const Category = mongoose.model('Category', categorySchema);

// ===== ADMIN SCHEMA =====
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const Admin = mongoose.model('Admin', adminSchema);

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== SIMPLE AUTH MIDDLEWARE =====
const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (token === process.env.ADMIN_SECRET_TOKEN) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// ===== ADMIN LOGIN =====
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    res.json({ success: true, token: process.env.ADMIN_SECRET_TOKEN });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ===== SLUG HELPERS =====
function makeBaseSlug(title) {
  let slug = slugify(title || '', { lowercase: true, separator: '-', trim: true });
  slug = slug
    .replace(/-/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug;
}

async function generateUniqueSlug(title, excludeId = null) {
  let baseSlug = makeBaseSlug(title);
  if (!baseSlug) baseSlug = 'story';

  let slug = baseSlug;
  let counter = 2;
  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await Story.findOne(query).select('_id').lean();
    if (!exists) return slug;
    slug = `${baseSlug}_${counter++}`;
  }
}

async function migrateStorySlugs() {
  const stories = await Story.find({
    $or: [{ slug: { $exists: false } }, { slug: '' }, { slug: null }]
  }).sort({ createdAt: 1 });

  for (const story of stories) {
    const slug = await generateUniqueSlug(story.title, story._id);
    await Story.updateOne({ _id: story._id }, { $set: { slug } });
    console.log(`🔗 Slug created: ${story.title} -> ${slug}`);
  }
}

// ===== PUBLIC API ROUTES =====

// GET all stories (with pagination + filter)
app.get('/api/stories', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const category = req.query.category;
    const search = req.query.search;
    const sort = req.query.sort || 'newest';

    let query = { status: 'published' };
    if (category) query.categories = { $in: [category] };
    if (search) query.title = { $regex: search, $options: 'i' };

    let sortObj = {};
    if (sort === 'newest') sortObj = { createdAt: -1 };
    else if (sort === 'popular') sortObj = { views: -1 };
    else if (sort === 'hot') { query.isHot = true; sortObj = { createdAt: -1 }; }

    const total = await Story.countDocuments(query);
    const stories = await Story.find(query)
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-content');

    res.json({
      stories,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single story by clean slug
// IMPORTANT: keep this route BEFORE /api/stories/:id
app.get('/api/stories/slug/:slug', async (req, res) => {
  try {
    const requestedSlug = String(req.params.slug || '').trim();
    let story = await Story.findOne({
      slug: requestedSlug,
      status: 'published'
    });

    // Backward-compatible fallback for older stories that were created
    // before the slug field existed. This lets their clean title URL work
    // even before the startup migration has completed.
    if (!story) {
      const candidates = await Story.find({ status: 'published' })
        .select('_id title slug author content excerpt image imagePublicId categories tags views isHot isNew status createdAt updatedAt')
        .lean();

      const match = candidates.find(item => makeBaseSlug(item.title) === requestedSlug);

      if (match) {
        story = await Story.findById(match._id);

        if (!story.slug) {
          try {
            const newSlug = await generateUniqueSlug(story.title, story._id);
            story.slug = newSlug;
            await Story.updateOne({ _id: story._id }, { $set: { slug: newSlug } });
          } catch (_) {}
        }
      }
    }

    if (!story) return res.status(404).json({ error: 'Story not found' });

    await Story.findByIdAndUpdate(story._id, { $inc: { views: 1 } });
    story.views = (story.views || 0) + 1;
    res.json(story);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single story
app.get('/api/stories/:id', async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });

    // Increment views
    await Story.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } });

    res.json(story);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Category.find();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ADMIN API ROUTES =====

// CREATE story with image upload
app.post('/api/admin/stories', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, author, content, categories, tags, isHot, isNew, status } = req.body;

    // Auto-generate excerpt
    const cleanContent = content.replace(/<[^>]*>/g, '').substring(0, 150);
    const excerpt = cleanContent + '...';

    const storyData = {
      title,
      slug: await generateUniqueSlug(title),
      author: author || 'অজ্ঞাত',
      content,
      excerpt,
      categories: categories ? JSON.parse(categories) : [],
      tags: tags ? JSON.parse(tags) : [],
      isHot: isHot === 'true',
      isNew: isNew !== 'false',
      status: status || 'published'
    };

    if (req.file) {
      storyData.image = req.file.path;
      storyData.imagePublicId = req.file.filename;
    }

    const story = new Story(storyData);
    await story.save();

    res.json({ success: true, story });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE story
app.put('/api/admin/stories/:id', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, author, content, categories, tags, isHot, isNew, status } = req.body;

    const updateData = {
      title,
      slug: await generateUniqueSlug(title, req.params.id),
      author,
      content,
      categories: categories ? JSON.parse(categories) : [],
      tags: tags ? JSON.parse(tags) : [],
      isHot: isHot === 'true',
      isNew: isNew !== 'false',
      status,
      updatedAt: new Date()
    };

    // Update excerpt
    if (content) {
      const cleanContent = content.replace(/<[^>]*>/g, '').substring(0, 150);
      updateData.excerpt = cleanContent + '...';
    }

    if (req.file) {
      // Delete old image from cloudinary
      const oldStory = await Story.findById(req.params.id);
      if (oldStory && oldStory.imagePublicId) {
        await cloudinary.uploader.destroy(oldStory.imagePublicId);
      }
      updateData.image = req.file.path;
      updateData.imagePublicId = req.file.filename;
    }

    const story = await Story.findByIdAndUpdate(req.params.id, updateData, { new: true });
    res.json({ success: true, story });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE story
app.delete('/api/admin/stories/:id', adminAuth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });

    // Delete image from cloudinary
    if (story.imagePublicId) {
      await cloudinary.uploader.destroy(story.imagePublicId);
    }

    await Story.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all stories for admin (including drafts)
app.get('/api/admin/stories', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search;

    let query = {};
    if (search) query.title = { $regex: search, $options: 'i' };

    const total = await Story.countDocuments(query);
    const stories = await Story.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-content');

    res.json({ stories, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single story for admin
app.get('/api/admin/stories/:id', adminAuth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });
    res.json(story);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN category management
app.post('/api/admin/categories', adminAuth, async (req, res) => {
  try {
    const { name, slug, icon } = req.body;
    const cat = new Category({ name, slug, icon });
    await cat.save();
    res.json({ success: true, cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  try {
    await Category.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats for admin dashboard
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalStories = await Story.countDocuments();
    const published = await Story.countDocuments({ status: 'published' });
    const drafts = await Story.countDocuments({ status: 'draft' });
    const totalViews = await Story.aggregate([
      { $group: { _id: null, total: { $sum: '$views' } } }
    ]);

    res.json({
      totalStories,
      published,
      drafts,
      totalViews: totalViews[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve main site
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Seed default categories if empty
async function seedCategories() {
  const count = await Category.countDocuments();
  if (count === 0) {
    const defaults = [
      { name: 'জনপ্রিয়', slug: 'popular', icon: '🔥' },
      { name: 'নতুন গল্প', slug: 'new', icon: '💚' },
      { name: 'বাস্তব ঘটনা', slug: 'real', icon: '📖' },
      { name: 'পরকীয়া', slug: 'porkiya', icon: '💜' },
      { name: 'গৃহবধু', slug: 'grihobodhu', icon: '👥' },
      { name: 'শিক্ষক-ছাত্রী', slug: 'teacher-student', icon: '☕' },
      { name: 'বিয়ের গল্প', slug: 'wedding', icon: '💍' },
      { name: 'অফিস', slug: 'office', icon: '🏢' }
    ];
    await Category.insertMany(defaults);
    console.log('✅ Default categories seeded');
  }
}

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
    await seedCategories();
    await migrateStorySlugs();
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Startup Error:', err);
    process.exit(1);
  }
}

startServer();
