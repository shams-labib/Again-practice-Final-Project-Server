const express = require("express");
const cors = require("cors");
require("dotenv").config();
const port = 3000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// MiddleWere
app.use(express.json());
app.use(cors());

const crypto = require("crypto");

function generateTrackingId() {
  const prefix = "PS"; // optional prefix (Mal Shift)

  // Date: YYYYMMDD
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Random 6-character hex (3 bytes)
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${random}`;
}

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const uri = process.env.DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db("mal-shift-server");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payment");
    const ridersCollection = db.collection("riders");
    const usersCollection = db.collection("users");

    // Users Collection
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const userExits = await usersCollection.findOne({ email });
      if (userExits) {
        return res.send("User already exits");
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName = { $regex: searchText, $options: "i" };
        query.$or = [{ displayName: { $regex: searchText, $options: "i" } }];
        query.$or = [{ email: { $regex: searchText, $options: "i" } }];
      }
      const cursor = await usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(cursor);
    });

    // user Update
    app.patch("/user/:id/role", async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // parcels collection
    app.post("/parcels", async (req, res) => {
      const parcels = req.body;
      parcels.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcels);
      res.send(result);
    });

    app.get("/parcels", async (req, res) => {
      const { email, deliveryStatus } = req.query;
      const query = {};
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const result = await parcelCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });
    // main mal parcels
    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, parcelId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: "delivery_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };

      const result = await parcelCollection.updateOne(query, updatedDoc);

      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };

      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );
      res.send(riderResult);
    });

    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `Please pay for ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],

        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    // decoded sessions
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            trackingId: trackingId,
          },
        };
        const result = await parcelCollection.updateOne(query, updateDoc);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);
          return res.send({
            success: true,
            modifyParcel: result,
            paymentInfo: resultPayment,
            trackingId: trackingId,
            transactionId: session.payment_intent,
          });
        }

        // res.send(result);
      }

      return res.send({ success: false });
    });

    app.get("/payment", async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;
      }
      const cursor = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(cursor);
    });

    // Riders collection section
    app.post("/rider", async (req, res) => {
      const riders = req.body;
      riders.createdAt = new Date();
      riders.status = "pending";
      const result = await ridersCollection.insertOne(riders);
      res.send(result);
    });

    app.get("/rider", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = await ridersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(cursor);
    });

    app.patch("/rider/:id", async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };

      const result = await ridersCollection.updateOne(query, updateDoc);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await usersCollection.updateOne(
          userQuery,
          updateUser
        );
      }

      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send("This is mal");
});

app.listen(port, () => {
  console.log(`This is port ${port}`);
});
