const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;


/* =========================================
   CLOUDINARY CONFIG
========================================= */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});


/* =========================================
   CLOUDINARY STORAGE
========================================= */

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,

  params: {
    folder: 'bangla-choti',

    allowed_formats: [
      'jpg',
      'jpeg',
      'png',
      'webp'
    ],

    transformation: [
      {
        width: 400,
        height: 280,
        crop: 'fill',
        quality: 'auto'
      }
    ]
  }
});


const upload = multer({

  storage: storage,

  limits: {
    fileSize: 5 * 1024 * 1024
  }

});


/* =========================================
   MONGODB CONNECTION
========================================= */

mongoose.connect(
  process.env.MONGODB_URI
)

.then(() => {
  console.log('✅ MongoDB Connected');
})

.catch(err => {
  console.error(
    '❌ MongoDB Error:',
    err
  );
});


/* =========================================
   STORY SCHEMA
========================================= */

const storySchema = new mongoose.Schema({

  title: {
    type: String,
    required: true
  },

  author: {
    type: String,
    default: 'অজ্ঞাত'
  },

  content: {
    type: String,
    required: true
  },

  excerpt: {
    type: String
  },

  image: {
    type: String,
    default: ''
  },

  imagePublicId: {
    type: String,
    default: ''
  },

  categories: [
    {
      type: String
    }
  ],

  tags: [
    {
      type: String
    }
  ],

  /* MANUAL / REAL VIEWS */

  views: {
    type: Number,
    default: 0
  },

  isHot: {
    type: Boolean,
    default: false
  },

  isNew: {
    type: Boolean,
    default: true
  },

  status: {
    type: String,

    enum: [
      'published',
      'draft'
    ],

    default: 'published'
  },

  /* MANUAL PUBLICATION DATE */

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }

});


const Story =
  mongoose.model(
    'Story',
    storySchema
  );


/* =========================================
   CATEGORY SCHEMA
========================================= */

const categorySchema =
  new mongoose.Schema({

    name: {
      type: String,
      required: true
    },

    slug: {
      type: String,
      required: true,
      unique: true
    },

    icon: {
      type: String,
      default: '📖'
    }

  });


const Category =
  mongoose.model(
    'Category',
    categorySchema
  );


/* =========================================
   ADMIN SCHEMA
========================================= */

const adminSchema =
  new mongoose.Schema({

    username: {
      type: String,
      required: true,
      unique: true
    },

    password: {
      type: String,
      required: true
    }

  });


const Admin =
  mongoose.model(
    'Admin',
    adminSchema
  );


/* =========================================
   MIDDLEWARE
========================================= */

app.use(cors());

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


/* =========================================
   ADMIN AUTH
========================================= */

const adminAuth =
  (req, res, next) => {

    const token =
      req.headers[
        'x-admin-token'
      ];

    if (
      token ===
      process.env
        .ADMIN_SECRET_TOKEN
    ) {

      next();

    } else {

      res
        .status(401)
        .json({
          error:
            'Unauthorized'
        });

    }

  };


/* =========================================
   ADMIN LOGIN
========================================= */

app.post(
  '/api/admin/login',
  async (req, res) => {

    const {
      username,
      password
    } = req.body;


    if (

      username ===
      process.env
        .ADMIN_USERNAME &&

      password ===
      process.env
        .ADMIN_PASSWORD

    ) {

      res.json({

        success: true,

        token:
          process.env
            .ADMIN_SECRET_TOKEN

      });

    } else {

      res
        .status(401)
        .json({
          error:
            'Invalid credentials'
        });

    }

  }
);


/* =========================================
   PUBLIC STORIES
========================================= */

app.get(
  '/api/stories',
  async (req, res) => {

    try {

      const page =
        parseInt(
          req.query.page
        ) || 1;

      const limit =
        parseInt(
          req.query.limit
        ) || 10;

      const category =
        req.query.category;

      const search =
        req.query.search;

      const sort =
        req.query.sort ||
        'newest';


      let query = {
        status:
          'published'
      };


      if (category) {

        query.categories = {
          $in: [category]
        };

      }


      if (search) {

        query.title = {
          $regex: search,
          $options: 'i'
        };

      }


      let sortObj = {};


      if (
        sort ===
        'newest'
      ) {

        sortObj = {
          createdAt: -1
        };

      }

      else if (
        sort ===
        'popular'
      ) {

        sortObj = {
          views: -1
        };

      }

      else if (
        sort ===
        'hot'
      ) {

        query.isHot =
          true;

        sortObj = {
          createdAt: -1
        };

      }


      const total =
        await Story.countDocuments(
          query
        );


      const stories =
        await Story.find(
          query
        )

        .sort(
          sortObj
        )

        .skip(
          (page - 1) *
          limit
        )

        .limit(
          limit
        )

        .select(
          '-content'
        );


      res.json({

        stories,

        total,

        page,

        totalPages:
          Math.ceil(
            total / limit
          )

      });


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   SINGLE STORY
========================================= */

app.get(
  '/api/stories/:id',
  async (req, res) => {

    try {

      const story =
        await Story.findById(
          req.params.id
        );


      if (!story) {

        return res
          .status(404)
          .json({
            error:
              'Story not found'
          });

      }


      /* REAL VIEW +1 */

      await Story.findByIdAndUpdate(

        req.params.id,

        {
          $inc: {
            views: 1
          }
        }

      );


      /* Return updated view */

      story.views =
        (story.views || 0) + 1;


      res.json(
        story
      );


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   CATEGORIES
========================================= */

app.get(
  '/api/categories',
  async (req, res) => {

    try {

      const categories =
        await Category.find();

      res.json(
        categories
      );

    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   ADMIN CREATE STORY
========================================= */

app.post(
  '/api/admin/stories',
  adminAuth,
  upload.single('image'),

  async (req, res) => {

    try {

      const {
        title,
        author,
        content,
        categories,
        tags,
        isHot,
        isNew,
        status,

        /* NEW */
        createdAt,
        views

      } = req.body;


      /* EXCERPT */

      const cleanContent =
        content
          .replace(
            /<[^>]*>/g,
            ''
          )
          .substring(
            0,
            150
          );


      const excerpt =
        cleanContent +
        '...';


      /* DATE */

      let finalCreatedAt =
        new Date();


      if (
        createdAt &&
        /^\d{4}-\d{2}-\d{2}$/.test(
          createdAt
        )
      ) {

        finalCreatedAt =
          new Date(
            `${createdAt}T00:00:00`
          );

      }


      /* VIEWS */

      let finalViews = 0;


      if (
        views !== undefined &&
        views !== ''
      ) {

        const parsedViews =
          Number(views);


        if (
          Number.isFinite(
            parsedViews
          ) &&
          parsedViews >= 0
        ) {

          finalViews =
            Math.floor(
              parsedViews
            );

        }

      }


      /* STORY DATA */

      const storyData = {

        title,

        author:
          author ||
          'অজ্ঞাত',

        content,

        excerpt,

        categories:
          categories
            ? JSON.parse(
                categories
              )
            : [],

        tags:
          tags
            ? JSON.parse(
                tags
              )
            : [],

        isHot:
          isHot === 'true',

        isNew:
          isNew !== 'false',

        status:
          status ||
          'published',

        /* NEW */

        createdAt:
          finalCreatedAt,

        views:
          finalViews

      };


      /* IMAGE */

      if (req.file) {

        storyData.image =
          req.file.path;

        storyData.imagePublicId =
          req.file.filename;

      }


      const story =
        new Story(
          storyData
        );


      await story.save();


      res.json({

        success: true,

        story

      });


    } catch (err) {

      console.error(
        'CREATE STORY ERROR:',
        err
      );


      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   ADMIN UPDATE STORY
========================================= */

app.put(
  '/api/admin/stories/:id',
  adminAuth,
  upload.single('image'),

  async (req, res) => {

    try {

      const {
        title,
        author,
        content,
        categories,
        tags,
        isHot,
        isNew,
        status,

        /* NEW */
        createdAt,
        views

      } = req.body;


      /* BASIC UPDATE */

      const updateData = {

        title,

        author,

        content,

        categories:
          categories
            ? JSON.parse(
                categories
              )
            : [],

        tags:
          tags
            ? JSON.parse(
                tags
              )
            : [],

        isHot:
          isHot === 'true',

        isNew:
          isNew !== 'false',

        status,

        updatedAt:
          new Date()

      };


      /* UPDATE EXCERPT */

      if (content) {

        const cleanContent =
          content
            .replace(
              /<[^>]*>/g,
              ''
            )
            .substring(
              0,
              150
            );


        updateData.excerpt =
          cleanContent +
          '...';

      }


      /* UPDATE DATE */

      if (
        createdAt &&
        /^\d{4}-\d{2}-\d{2}$/.test(
          createdAt
        )
      ) {

        updateData.createdAt =
          new Date(
            `${createdAt}T00:00:00`
          );

      }


      /* UPDATE VIEWS */

      if (
        views !== undefined &&
        views !== ''
      ) {

        const parsedViews =
          Number(views);


        if (
          Number.isFinite(
            parsedViews
          ) &&
          parsedViews >= 0
        ) {

          updateData.views =
            Math.floor(
              parsedViews
            );

        }

      }


      /* UPDATE IMAGE */

      if (req.file) {

        const oldStory =
          await Story.findById(
            req.params.id
          );


        if (
          oldStory &&
          oldStory.imagePublicId
        ) {

          await cloudinary
            .uploader
            .destroy(
              oldStory.imagePublicId
            );

        }


        updateData.image =
          req.file.path;

        updateData.imagePublicId =
          req.file.filename;

      }


      /* SAVE */

      const story =
        await Story.findByIdAndUpdate(

          req.params.id,

          updateData,

          {
            new: true
          }

        );


      if (!story) {

        return res
          .status(404)
          .json({
            error:
              'Story not found'
          });

      }


      res.json({

        success: true,

        story

      });


    } catch (err) {

      console.error(
        'UPDATE STORY ERROR:',
        err
      );


      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   DELETE STORY
========================================= */

app.delete(
  '/api/admin/stories/:id',
  adminAuth,

  async (req, res) => {

    try {

      const story =
        await Story.findById(
          req.params.id
        );


      if (!story) {

        return res
          .status(404)
          .json({
            error:
              'Not found'
          });

      }


      if (
        story.imagePublicId
      ) {

        await cloudinary
          .uploader
          .destroy(
            story.imagePublicId
          );

      }


      await Story.findByIdAndDelete(
        req.params.id
      );


      res.json({
        success: true
      });


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   ADMIN STORIES
========================================= */

app.get(
  '/api/admin/stories',
  adminAuth,

  async (req, res) => {

    try {

      const page =
        parseInt(
          req.query.page
        ) || 1;

      const limit =
        parseInt(
          req.query.limit
        ) || 20;

      const search =
        req.query.search;


      let query = {};


      if (search) {

        query.title = {
          $regex: search,
          $options: 'i'
        };

      }


      const total =
        await Story.countDocuments(
          query
        );


      const stories =
        await Story.find(
          query
        )

        .sort({
          createdAt: -1
        })

        .skip(
          (page - 1) *
          limit
        )

        .limit(
          limit
        )

        .select(
          '-content'
        );


      res.json({

        stories,

        total,

        page,

        totalPages:
          Math.ceil(
            total / limit
          )

      });


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   ADMIN SINGLE STORY
========================================= */

app.get(
  '/api/admin/stories/:id',
  adminAuth,

  async (req, res) => {

    try {

      const story =
        await Story.findById(
          req.params.id
        );


      if (!story) {

        return res
          .status(404)
          .json({
            error:
              'Not found'
          });

      }


      res.json(
        story
      );


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   ADD CATEGORY
========================================= */

app.post(
  '/api/admin/categories',
  adminAuth,

  async (req, res) => {

    try {

      const {
        name,
        slug,
        icon
      } = req.body;


      const cat =
        new Category({

          name,

          slug,

          icon

        });


      await cat.save();


      res.json({

        success: true,

        cat

      });


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   DELETE CATEGORY
========================================= */

app.delete(
  '/api/admin/categories/:id',
  adminAuth,

  async (req, res) => {

    try {

      await Category.findByIdAndDelete(
        req.params.id
      );


      res.json({
        success: true
      });


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   ADMIN STATS
========================================= */

app.get(
  '/api/admin/stats',
  adminAuth,

  async (req, res) => {

    try {

      const totalStories =
        await Story.countDocuments();


      const published =
        await Story.countDocuments({
          status:
            'published'
        });


      const drafts =
        await Story.countDocuments({
          status:
            'draft'
        });


      const totalViews =
        await Story.aggregate([

          {
            $group: {

              _id: null,

              total: {
                $sum:
                  '$views'
              }

            }

          }

        ]);


      res.json({

        totalStories,

        published,

        drafts,

        totalViews:
          totalViews[0]?.total ||
          0

      });


    } catch (err) {

      res
        .status(500)
        .json({
          error:
            err.message
        });

    }

  }
);


/* =========================================
   SERVE MAIN SITE
========================================= */

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );

  }
);


/* =========================================
   SERVE ADMIN
========================================= */

app.get(
  '/admin',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'admin.html'
      )
    );

  }
);


/* =========================================
   DEFAULT CATEGORIES
========================================= */

async function seedCategories() {

  const count =
    await Category.countDocuments();


  if (count === 0) {

    const defaults = [

      {
        name: 'জনপ্রিয়',
        slug: 'popular',
        icon: '🔥'
      },

      {
        name: 'নতুন গল্প',
        slug: 'new',
        icon: '💚'
      },

      {
        name: 'বাস্তব ঘটনা',
        slug: 'real',
        icon: '📖'
      },

      {
        name: 'পরকীয়া',
        slug: 'porkiya',
        icon: '💜'
      },

      {
        name: 'গৃহবধু',
        slug: 'grihobodhu',
        icon: '👥'
      },

      {
        name: 'শিক্ষক-ছাত্রী',
        slug: 'teacher-student',
        icon: '☕'
      },

      {
        name: 'বিয়ের গল্প',
        slug: 'wedding',
        icon: '💍'
      },

      {
        name: 'অফিস',
        slug: 'office',
        icon: '🏢'
      }

    ];


    await Category.insertMany(
      defaults
    );


    console.log(
      '✅ Default categories seeded'
    );

  }

}


/* =========================================
   START SERVER
========================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

    await seedCategories();

  }
);