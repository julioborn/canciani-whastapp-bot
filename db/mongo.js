const mongoose = require("mongoose");

async function connectMongo() {
    if (mongoose.connection.readyState === 1) return;

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("🟢 MongoDB conectado");
    } catch (error) {
        console.error("🔴 Error conectando MongoDB:", error);
        process.exit(1);
    }
}

module.exports = connectMongo;
