require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const morgan = require('morgan');
const winston = require('winston');
const chalk = require('chalk');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", 1);
app.use(cors({
  origin: 'https://invoice-it-frontend.vercel.app', 
  methods: ['GET', 'POST', 'OPTIONS'], // Allow specific HTTP methods
  credentials: true, // Allow cookies and authentication headers
}));

const prisma = new PrismaClient({
    datasources: {
        db: { url: process.env.DATABASE_URL }
    }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    host: 'smtp.gmail.com',
    secure: true,
    auth: {
      user: process.env.EMAIL_USER, 
      pass: process.env.EMAIL_PASS,
    },
});
  
const generateInvoiceHtml = (quotation) => {
    let itemsHtml = '';
    quotation.quotationItems.forEach(item => {
      itemsHtml += `
        <tr>
          <td>${item.productName}</td>
          <td>${item.quantity}</td>
          <td>${item.price}</td>
          <td>${item.amount}</td>
        </tr>
      `;
    });
  
    return `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
        <h2 style="text-align: center; color: #5E17EB;">Invoice for Quotation from  ${quotation.quotationBy.businessName}</h2>
        <p><strong>To:</strong> ${quotation.quotationOf.name}</p>
        
        <h3>Quotation Details:</h3>
        <table border="1" cellpadding="10" cellspacing="0" style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #5E17EB; color: white;">
              <th>Product</th>
              <th>Quantity</th>
              <th>Price</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        <h3 style="margin-top: 20px;">Grand Total: ₹${quotation.grandTotal}</h3>
        <p>If you have any questions, please feel free to contact us.</p>
        <p>Thank you for doing business with us!</p>
      </div>
    `;
};
const JWT_SECRET = process.env.JWT_SECRET;
const saltRounds = 10;

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console(),
    ]
});


const customMorganFormat = (tokens, req, res) => {
    const status = res.statusCode;
    let color = chalk.white;  

    if (status >= 200 && status < 300) {
        color = chalk.green;
    } else if (status >= 300 && status < 400) {
        color = chalk.cyan;
    } else if (status >= 400 && status < 500) {
        color = chalk.yellow;
    } else if (status >= 500) {
        color = chalk.red;   
    }

    return color(
        `${tokens.method(req, res)} ${tokens.url(req, res)} ${status} - ${tokens['response-time'](req, res)} ms`
    );
};

app.use(
    morgan(customMorganFormat, {
        stream: {
            write: (message) => logger.info(message.trim())
        }
    })
);

const authenticateJWT = async (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ message: 'Authentication required' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { id: decoded.id, email: decoded.email };
        next();
    } catch (err) {
        next({ status: 403, message: 'Invalid or expired token' });
    }
};

app.post('/register', async (req, res, next) => {
    try {
        const { name, email, password, businessName, phone, address, GSTIN } = req.body;
        const hash = await bcrypt.hash(password, saltRounds);
        const newUser = await prisma.User.create({
            data: { name, email, password: hash, phone, businessName, address, GSTIN }
        });
        res.status(201).json(newUser);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.User.findUnique({ where: { email } });
        if (!user) return res.status(403).json({ message: 'Invalid email' });
        if (!(await bcrypt.compare(password, user.password))) {
            return res.status(403).json({ message: 'Invalid password' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
        res.cookie('token', token, {
            httpOnly: true,       // Prevents access via JavaScript (for security)
            secure: true,         // Ensures the cookie is sent only over HTTPS
            same_site: 'None',     // Allows cross-origin cookies
            domain: 'invoice-it-frontend.vercel.app', // Target domain for the cookie
        });
        res.json({ message: 'Login successful', user });
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.get('/allProduct', authenticateJWT, async (req, res, next) => {
    try {
        const products = await prisma.Product.findMany({
            where: { userId: req.user.id }
        });
        res.json(products);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.post('/addProduct', authenticateJWT, async (req, res, next) => {
    try {
        const { title, price, description } = req.body;
        if(description) {
            const newProduct = await prisma.Product.create({
                data: {
                    title,
                    price: Number(price),
                    description: description,
                    userId: req.user.id
                }
            });
            res.status(201).json(newProduct);
        }
        else {
            const newProduct = await prisma.Product.create({
                data: {
                    title,
                    price: Number(price),
                    userId: req.user.id
                }
            });
            res.status(201).json(newProduct);
        }
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.put('/editProduct/:productId', authenticateJWT, async (req, res, next) => {
    try {
        const { productId } = req.params;
        const { title, price, description} = req.body;
        if(!description) {
            const updatedProduct = await prisma.Product.updateMany({
                where: { id: Number(productId), userId: req.user.id },
                data: { title, price: Number(price) }
            });
            res.status(201).json(updatedProduct);
        }
        else {
            const updatedProduct = await prisma.Product.updateMany({
                where: { id: Number(productId), userId: req.user.id },
                data: { title, price: Number(price), description: description }
            });
            res.status(201).json(updatedProduct);
        }
        
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.get('/allCustomer', authenticateJWT, async (req, res, next) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const skip = (page - 1) * limit;

        const customers = await prisma.Customer.findMany({
            where: { userId: req.user.id },
            skip: Number(skip),
            take: Number(limit)
        });
        const total = await prisma.Customer.count({
            where: { userId: req.user.id }
        });
        res.json({ total, page: Number(page), customers });
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.post('/addCustomer', authenticateJWT, async (req, res, next) => {
    try {
        const { email, address, name, phone } = req.body;
        const newCustomer = await prisma.Customer.create({
            data: {
                email,
                address,
                name,
                phone,
                userId: req.user.id
            }
        });
        res.status(201).json(newCustomer);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.put('/editCustomer/:customerId', authenticateJWT, async (req, res, next) => {
    try {
        const { customerId } = req.params;
        const { email, address, name, phone } = req.body;

        const updatedCustomer = await prisma.Customer.updateMany({
            where: { id: Number(customerId), userId: req.user.id },
            data: { email, address, name, phone }
        });
        res.status(201).json(updatedCustomer);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went Wrong");
    }
});

app.post('/createQuotation', authenticateJWT, async (req, res, next) => {
    try {
        const { customerId, items } = req.body;

        const customer = await prisma.Customer.findUnique({
            where: { id: customerId },
            include: {
                clientOf: true,  
            },
        });

        if (!customer || customer.clientOf.email !== req.user.email) {
            return res.status(404).json({ message: 'Customer not found or does not belong to you' });
        }

        const productIds = items.map(item => item.productId);
        const products = await prisma.Product.findMany({
            where: {
                id: { in: productIds },
                userId: req.user.id,  
            },
        });

        if (products.length !== productIds.length) {
            return res.status(404).json({ message: 'Some products not found or do not belong to you' });
        }

        const grandTotal = items.reduce((total, item) => total + item.price * item.quantity, 0);

        const newQuotation = await prisma.Quotation.create({
            data: {
                quotationOf: { connect: { id: customerId } },
                quotationBy: { connect: { email: req.user.email } },
                quotationItems: {
                    create: items.map(item => ({
                        quantity: item.quantity,
                        productName: item.productName,
                        price: item.price,
                        amount: item.quantity * item.price,
                        product: { connect: { id: item.productId } },
                    }))
                },
                grandTotal: grandTotal
            }
        });

        res.status(201).json(newQuotation);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went wrong");
    }
});

app.put('/editQuotation/:quotationId', authenticateJWT, async (req, res, next) => {
    try {
        const { quotationId } = req.params;
        const { items } = req.body;

        const quotation = await prisma.Quotation.findUnique({
            where: { id: Number(quotationId) },
            include: {
                quotationBy: true, 
            },
        });

        if (!quotation || quotation.quotationBy.email !== req.user.email) {
            return res.status(404).json({ message: 'Quotation not found or does not belong to you' });
        }

        const customer = await prisma.Customer.findUnique({
            where: { id: quotation.customerId },
            include: {
                clientOf: true, 
            },
        });

        if (!customer || customer.clientOf.email !== req.user.email) {
            return res.status(404).json({ message: 'Customer not found or does not belong to you' });
        }

        const productIds = items.map(item => item.productId);
        const products = await prisma.Product.findMany({
            where: {
                id: { in: productIds },
                userId: req.user.email, 
            },
        });

        if (products.length !== productIds.length) {
            return res.status(404).json({ message: 'Some products not found or do not belong to you' });
        }

        const grandTotal = items.reduce((total, item) => total + item.price * item.quantity, 0);

        const updatedQuotation = await prisma.Quotation.update({
            where: { id: Number(quotationId) },
            data: {
                quotationItems: {
                    deleteMany: {},
                    create: items.map((item) => ({
                        quantity: item.quantity,
                        productName: item.productName,
                        price: item.price,
                        amount: item.quantity * item.price,
                        product: { connect: { id: item.productId } },
                    }))
                },
                grandTotal,
            }
        });
        res.status(201).json(updatedQuotation);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went wrong");
    }
});

app.get('/allQuotation', authenticateJWT, async (req, res) => {
    try {
        const allQuotations = await prisma.Quotation.findMany({
            where: {
                quotationBy: {
                    email: req.user.email,
                },
            },
            include: {
                quotationItems: {
                    include: {
                        product: true, 
                    }
                },
                quotationOf: {
                    include: true,
                }
            },
        });
        res.status(200).json(allQuotations);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went wrong");
    }
});

app.get('/allQuotation/dashboard', authenticateJWT, async (req, res) => {
    try {
        const allQuotation = await prisma.Quotation.findMany({
            where: {
                quotationBy: {
                    email: req.user.email,
                },
            },
            include: {
                quotationItems: {
                    include: {
                        product: true, 
                    }
                },
                quotationOf: {
                    include: true,
                }
            },
        });
        const allQuotations = allQuotation.map(item => ({
            id: item.id,
            createdAt: item.createdAt,
            grandTotal: item.grandTotal,
            customer: item.quotationOf.name
        }))
        res.status(200).json(allQuotations);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went wrong");
    }
});

app.get('/quotation/:id', authenticateJWT, async (req, res) => {
    try {
        const Quotation = await prisma.Quotation.findUnique({
            where: {
                id: Number(req.params.id),
            },
            include: {
                quotationItems: {
                    include: {
                        product: true, 
                    }
                },
                quotationOf: {
                    include: true,
                },
                quotationBy: {
                    include: true
                }
            },
        });
        const NewQuotations = {
            id: Quotation.id,
            createdAt: Quotation.createdAt,
            grandTotal: Quotation.grandTotal,
            businessName: Quotation.quotationBy.businessName,
            userAddress: Quotation.quotationBy.address,
            userPhone: Quotation.quotationBy.phone,
            userEmail: Quotation.quotationBy.email,
            customerName: Quotation.quotationOf.name,
            customerPhone: Quotation.quotationOf.phone,
            customerEmail: Quotation.quotationOf.email,
            customerAddress: Quotation.quotationOf.address,
            quotationItems: Quotation.quotationItems,

        }
        res.status(200).json(NewQuotations);
    } catch (error) {
        console.log(error);
        res.status(500).json("Something went wrong");
    }
});

app.post('/sendInvoice/:quotationId', authenticateJWT, async (req, res) => {
    try {
      const { quotationId } = req.params;
      const quotation = await prisma.quotation.findUnique({
        where: { id: Number(quotationId) },
        include: {
          quotationItems: true,
          quotationOf: true, 
          quotationBy: true,
        },
      });
  
      if (!quotation) {
        return res.status(404).json({ message: 'Quotation not found' });
      }
      
      if(quotation.userId !== req.user.id) {
        return res.status(404).json({ message: 'No Such quotation exists' });
      }
      const invoiceHtml = generateInvoiceHtml(quotation);
  
      const emailConfig = {
        from: process.env.EMAIL_USER, // Sender email (your email)
        to: quotation.quotationOf.email, // Customer email
        subject: `Invoice for Quotation #${quotation.id}`,
        html: invoiceHtml,
      };
  
      await transporter.sendMail(emailConfig);
  
      res.status(200).json({ message: 'Invoice sent successfully' });
    } catch (error) {
      console.log(error);
      res.status(500).json({ message: 'Something went wrong' });
    }
  });
  
  app.get('/validate-token', (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ message: 'Authentication required' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return res.status(201).json({ message: 'Authentication required' });
    } catch (err) {
        return res.status(401).json({ message: 'Authentication required' });
    }
  });

app.listen(8000, () => {
    logger.info('Server is running on port 8000');
});
