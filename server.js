const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
const { slugify } = require('transliteration');
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
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => { console.log('✅ MongoDB Connected'); await migrateStorySlugs(); })
  .catch(err => console.error('❌ MongoDB Error:', err));

// ===== STORY SCHEMA =====
const storySchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, default: 'অজ্ঞাত' },
  content: { type: String, required: true },
  excerpt: { type: String },
  image: { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
  categories: [{ type: String }],
  slug: { type: String, unique: true, sparse: true, index: true },
  tags: [{ type: String }],
  views: { type: Number, default: 0 },
  isHot: { type: Boolean, default: false },
  isNew: { type: Boolean, default: true },
  status: { type: String, enum: ['published', 'draft'], default: 'published' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Story = mongoose.model('Story', storySchema);


// ===== SERIES / RELATED STORY HELPERS =====
function parseSeriesTitle(title) {
  const raw = String(title || '').trim();
  // Supports: "পর্ব ১", "- পর্ব ১", "Part 1", "Episode 1"
  const m = raw.match(/^(.*?)(?:\s*[-–—:|]?\s*)(?:পর্ব|part|episode)\s*([0-9০-৯]+)\s*$/i);
  if (!m) return { base: null, part: null };
  const bn = '০১২৩৪৫৬৭৮৯';
  const part = Number(String(m[2]).replace(/[০-৯]/g, d => bn.indexOf(d)));
  return { base: m[1].trim().replace(/[\s_-]+$/g, ''), part: Number.isFinite(part) ? part : null };
}

function sameSeriesBase(a, b) {
  return String(a || '').trim().toLocaleLowerCase('bn-BD') === String(b || '').trim().toLocaleLowerCase('bn-BD');
}


function makeBaseSlug(title) {
  let slug = slugify(String(title || ''), { lowercase: true, separator: '-', trim: true });
  slug = slug.replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'story';
}

async function generateUniqueSlug(title, excludeId = null) {
  const base = makeBaseSlug(title);
  let slug = base;
  let n = 2;
  while (true) {
    const query = excludeId ? { slug, _id: { $ne: excludeId } } : { slug };
    const exists = await Story.findOne(query).select('_id').lean();
    if (!exists) return slug;
    slug = `${base}_${n++}`;
  }
}

async function migrateStorySlugs() {
  const stories = await Story.find({
    $or: [{ slug: { $exists: false } }, { slug: '' }, { slug: null }]
  }).sort({ createdAt: 1 });
  for (const story of stories) {
    story.slug = await generateUniqueSlug(story.title, story._id);
    await story.save();
  }
  if (stories.length) console.log(`🔗 Created slugs for ${stories.length} stories`);
}

async function migrateStoryCategoriesFromTags() {
  const stories = await Story.find({
    $or: [
      { categories: { $exists: false } },
      { categories: { $size: 0 } }
    ],
    tags: { $exists: true, $ne: [] }
  });
  let updated = 0;
  for (const story of stories) {
    const tagValues = Array.isArray(story.tags) ? story.tags.filter(Boolean).map(String) : [];
    if (tagValues.length) {
      story.categories = [...new Set(tagValues)];
      await story.save();
      updated++;
    }
  }
  if (updated) console.log(`🏷️ Copied tags to categories for ${updated} stories`);
}

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

// ===== PUBLIC API ROUTES =====

// GET all stories (with pagination + filter)
app.get('/api/stories', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(15, Math.max(1, parseInt(req.query.limit) || 15));
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

// GET series parts + related stories for a story page
// Must stay before /api/stories/:id so "related" is not treated as an ID.
app.get('/api/stories/related/:id', async (req, res) => {
  try {
    const current = await Story.findOne({ _id: req.params.id, status: 'published' })
      .select('title categories tags');
    if (!current) return res.status(404).json({ error: 'Story not found' });

    const currentInfo = parseSeriesTitle(current.title);
    let seriesParts = [];

    if (currentInfo.base && currentInfo.part !== null) {
      const candidates = await Story.find({
        status: 'published',
        _id: { $ne: current._id }
      }).select('title slug categories createdAt');

      seriesParts = candidates
        .map(story => ({ story, info: parseSeriesTitle(story.title) }))
        .filter(x => x.info.base && x.info.part !== null && sameSeriesBase(x.info.base, currentInfo.base))
        .sort((a, b) => a.info.part - b.info.part)
        .map(x => ({
          _id: x.story._id,
          title: x.story.title,
          slug: x.story.slug || '',
          part: x.info.part
        }));
    }

    // If the series has fewer than 5 parts in total, fill the remaining slots
    // with other published stories sharing at least one category.
    const totalSeriesParts = seriesParts.length + 1;
    let relatedStories = [];

    if (totalSeriesParts < 5) {
      const excludedIds = [current._id, ...seriesParts.map(p => p._id)];
      const categoryList = (Array.isArray(current.categories) && current.categories.length) ? current.categories : (Array.isArray(current.tags) ? current.tags : []);

      if (categoryList.length) {
        relatedStories = await Story.find({
          status: 'published',
          _id: { $nin: excludedIds },
          categories: { $in: categoryList }
        })
          .sort({ views: -1, createdAt: -1 })
          .limit(5)
          .select('title slug categories createdAt views');
      }
    }

    res.json({
      series: {
        hasSeries: currentInfo.base !== null && currentInfo.part !== null,
        currentPart: currentInfo.part,
        totalParts: totalSeriesParts,
        parts: seriesParts
      },
      related: relatedStories
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single published story by slug
app.get('/api/stories/slug/:slug', async (req, res) => {
  try {
    const story = await Story.findOne({ slug: req.params.slug, status: 'published' });
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
      categories: categories ? JSON.parse(categories) : (tags ? JSON.parse(tags) : []),
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
      categories: categories ? JSON.parse(categories) : (tags ? JSON.parse(tags) : []),
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

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  try {
    await mongoose.connection.asPromise();
    await seedCategories();
    await migrateStorySlugs();
    await migrateStoryCategoriesFromTags();
  } catch (err) {
    console.error('❌ Startup database task failed:', err);
  }
});