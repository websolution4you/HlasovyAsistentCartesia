require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ==========================================
// 1. SUPABASE (DATABÁZA) NASTAVENIA
// ==========================================
// Z .env súboru načítame URL a Service Key (pre obídenie RLS)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// 2. TWILIO WEBHOOK (KEĎ NIEKTO ZAVOLÁ NA VAŠE TWILIO ČÍSLO)
// ==========================================
// Stabilný model: zákazník zavolá na tvoje lokálne/európske Twilio číslo
// a Twilio hovor presmeruje na Cartesia telefónne číslo agenta.
// Cartesia potom rieši celý voice agent hovor sama (STT/LLM/TTS).
app.post('/twilio/voice', (req, res) => {
    console.log('Prišiel nový hovor z Twilia - presmerovávam na Cartesia číslo.');

    const cartesiaPhoneNumber = process.env.CARTESIA_PHONE_NUMBER;

    if (!cartesiaPhoneNumber) {
        console.error('Chýba CARTESIA_PHONE_NUMBER v environment variables.');

        const errorTwiml = `
<Response>
    <Say language="sk-SK">Prepáčte, hlasový asistent momentálne nie je dostupný.</Say>
    <Hangup />
</Response>`;

        res.type('text/xml');
        return res.send(errorTwiml);
    }

    const callerId = process.env.TWILIO_CALLER_ID || req.body.To;

    console.log(`Vytáčam Cartesia číslo: ${cartesiaPhoneNumber}`);
    console.log(`Používam callerId: ${callerId}`);

    // Twilio zavolá Cartesia agent číslo a premostí hovory.
    // action zavolá náš backend po skončení Dial pokusu a povie nám výsledok.
    // statusCallback posiela priebežné udalosti: initiated/ringing/answered/completed.
    const twiml = `
<Response>
    <Dial
        timeout="30"
        callerId="${callerId}"
        action="/twilio/dial-result"
        method="POST"
    >
        <Number
            statusCallback="/twilio/dial-status"
            statusCallbackMethod="POST"
            statusCallbackEvent="initiated ringing answered completed"
        >${cartesiaPhoneNumber}</Number>
    </Dial>
    <Say language="sk-SK">Prepáčte, hlasový asistent momentálne nie je dostupný.</Say>
</Response>`;

    res.type('text/xml');
    res.send(twiml);
});

app.post('/twilio/dial-status', (req, res) => {
    console.log('Twilio Dial status callback:', {
        CallSid: req.body.CallSid,
        ParentCallSid: req.body.ParentCallSid,
        CallStatus: req.body.CallStatus,
        To: req.body.To,
        From: req.body.From,
        Direction: req.body.Direction,
        Timestamp: req.body.Timestamp,
    });

    res.sendStatus(200);
});

app.post('/twilio/dial-result', (req, res) => {
    console.log('Twilio Dial result:', {
        DialCallStatus: req.body.DialCallStatus,
        DialCallSid: req.body.DialCallSid,
        DialCallDuration: req.body.DialCallDuration,
        CallSid: req.body.CallSid,
        From: req.body.From,
        To: req.body.To,
    });

    const twiml = `
<Response>
    <Hangup />
</Response>`;

    res.type('text/xml');
    res.send(twiml);
});

// ==========================================
// 3. CARTESIA TOOL CALL WEBHOOK (ULOŽENIE OBJEDNÁVKY)
// ==========================================
// Cartesia AI sem pošle POST request, keď AI rozhodne, že má dosť info (pizzu a adresu)
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

        // Uložíme do databázy Supabase do tabuľky 'orders'
        const { data, error } = await supabase
            .from('orders')
            .insert([{ pizza: pizza, adresa: adresa }])
            .select();

        if (error) {
            console.error('Chyba pri ukladaní do Supabase:', error);
            return res.status(500).json({ error: 'Chyba databázy' });
        }

        console.log(`✅ Objednávka uložená do Supabase (ID: ${data[0].id})`);

        // Vrátime Cartesii 'success', aby AI vedela, že to prešlo a môže povedať: "Objednávku som uložila, dopočutia."
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
// Render.com nám dáva port v premennej prostredia process.env.PORT
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 API Server beží na porte ${PORT}`);
    console.log('Twilio voice webhook: /twilio/voice');
    console.log('Cartesia order webhook: /api/uloz-objednavku');
});
