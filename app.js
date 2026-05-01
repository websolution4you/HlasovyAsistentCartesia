
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ==========================================
// 1. SUPABASE (DATABÁZA) NASTAVENIA
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// 2. TWILIO WEBHOOK - PRESMEROVANIE NA CARTESIA AGENTA
// ==========================================
app.post('/twilio/voice', (req, res) => {
    console.log('Prišiel nový hovor z Twilia - presmerovávam na Cartesia agenta:', {
        CallSid: req.body.CallSid,
        From: req.body.From,
        To: req.body.To,
    });

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.dial('+19342204498');

    res.type('text/xml');
    res.send(twiml.toString());
});

// ==========================================
// 3. CARTESIA TOOL CALL WEBHOOK (ULOŽENIE OBJEDNÁVKY)
// ==========================================
const authenticateWebhook = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const expectedToken = `Bearer ${process.env.AGENT_WEBHOOK_SECRET}`;

    if (!authHeader || authHeader !== expectedToken) {
        console.warn('Neautorizovaný pokus o uloženie objednávky z Cartesie');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

app.post('/api/uloz-objednavku', authenticateWebhook, async (req, res) => {
    try {
        const { pizza, adresa } = req.body;

        if (!pizza || !adresa) {
            return res.status(400).json({ error: 'Chýba pizza alebo adresa' });
        }

        console.log('\n=== 🍕 NOVÁ OBJEDNÁVKA ZO SYSTEMU CARTESIA 🍕 ===');
        console.log(`Pizza:  ${pizza}`);
        console.log(`Adresa: ${adresa}`);
        console.log('==================================================\n');

        const { data, error } = await supabase
            .from('orders')
            .insert([{ pizza: pizza, adresa: adresa }])
            .select();

        if (error) {
            console.error('Chyba pri ukladaní do Supabase:', error);
            return res.status(500).json({ error: 'Chyba databázy' });
        }

        console.log(`✅ Objednávka uložená do Supabase (ID: ${data[0].id})`);

        res.status(200).json({
            status: "success",
            message: "Objednávka bola úspešne uložená."
        });

    } catch (error) {
        console.error('Chyba vo webhooku pre objednávky:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==========================================
// 4. SPUSTENIE SERVERA (Pre Render.com)
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 API Server beží na porte ${PORT}`);
    console.log('Twilio voice webhook: /twilio/voice');
    console.log('Cartesia order webhook: /api/uloz-objednavku');
});
