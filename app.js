const express = require('express');
const {google} = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const bodyParser = require('body-parser');
const session = require('express-session');

const app = express();

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({ secret: 'keyboard cat', cookie: { maxAge: 60000 }, resave: true, saveUninitialized: true}));

app.set('view engine', 'ejs');

function listEvents(auth) {
  const calendar = google.calendar({version: 'v3', auth});
  calendar.events.list({
    calendarId: 'primary',
    timeMin: (new Date()).toISOString(),
    maxResults: 10,
    singleEvents: true,
    orderBy: 'startTime',
  }, (err, res) => {
    if (err) return console.log('The API returned an error: ' + err);
    const events = res.data.items;
    if (events.length) {
      console.log('Upcoming 10 events:');
      events.map((event, i) => {
        const start = event.start.dateTime || event.start.date;
        console.log(`${start} - ${event.summary}`);
      });
    } else {
      console.log('No upcoming events found.');
    }
  });
}

// 0      for class name
// 0 0,1  section name
// 0 2    start and end date

// 2      meeting days

// 10     meeting times
//        building and room

// 11     instructor
// 12     start of next class
function getEventsFromString(schedule, auth) {
  var arrayOfLines = schedule.match(/[^\r\n]+/g);
  var i;
  var classNames = [];
  var startDates = [];
  var endDates = [];
  var meetingDays = [];
  var meetingTimes = [];
  var location = [];
  var instructor = [];

  // Parse schedule string
  arrayOfLines[0].match(/Class Schedule for /g) ? i = 1 : i = 0;
  for (i; i<arrayOfLines.length; i++) {
    if (arrayOfLines[i].search("Message:") >= 0) i++;
    var title = arrayOfLines[i].split('|');
    classNames.push(title[1] + title[0]);
    startDates.push(title[2].replace("Class Begin: ", "").toString().replace(/[ ]+/g, ""));
    endDates.push(title[3].replace("Class End: ", "").toString().replace(/[ ]+/g, ""));
    i = i + 2;
    meetingDays.push(arrayOfLines[i].match(/([A-Za-z]).*/g).toString().replace(" ", ""));
    i = i + 8;
    meetingTimes.push(arrayOfLines[i].match(/.+?(?= Type)/g).toString().replace(/[ ]+/g, ""));
    location.push(arrayOfLines[i].match(/.Building:.*/g).toString().replace("Building: ", ""));
    i = i + 2;
  }

  // Loop through all classes
  const calendar = google.calendar({version: 'v3', auth});
  for (var i = 0; i < classNames.length; i++) {
    // split start and end dates by month, day, and year
    var startParts = startDates[i].split("/");
    var endParts = endDates[i].split("/");

    // split meeting time by start time and end time
    var timeParts = meetingTimes[i].split("-");
    // create string date and time and split the time from "AM" or "PM"
    var startDateString = startParts[2] + '/' + startParts[0] + '/' + startParts[1] + ' ' + timeParts[0].slice(0, 5) + ' ' + timeParts[0].slice(5);
    var endDateString = startParts[2] + '/' + startParts[0] + '/' + startParts[1] + ' ' + timeParts[1].slice(0, 5) + ' ' + timeParts[1].slice(5);

    startDate = new Date(startDateString);
    endDate = new Date(endDateString);

    // count the day in the week to add
    var dayCount = 0;
    var daySplit = meetingDays[i].split(",");
    if (daySplit[0].search("Tuesday") >= 0)
      dayCount = 1;
    else if (daySplit[0].search("Wednesday") >= 0)
      dayCount = 2;
    else if (daySplit[0].search("Thursday") >= 0)
      dayCount = 3;
    else if (daySplit[0].search("Friday") >= 0)
      dayCount = 4;
    else if (daySplit[0].search("Saturday") >= 0)
      dayCount = 5;
    else if (daySplit[0].search("Sunday") >= 0)
      dayCount = 6;

    // add offset from starting day to get actual start day of class
    startDate.setDate(startDate.getDate() + dayCount);
    endDate.setDate(endDate.getDate() + dayCount);
    startDate = startDate.toISOString();
    endDate = endDate.toISOString();

    // replace with recurrence standards
    var days = meetingDays[i].replace("Monday", "MO")
                             .replace("Tuesday", "TU")
                             .replace("Wednesday", "WE")
                             .replace("Thursday", "TH")
                             .replace("Friday", "FR")
                             .replace("Saturday", "SA")
                             .replace("Sunday", "SU");

    var untilDate = endParts[2] + endParts[0] + endParts[1] + 'T000000Z';
    var recurrence = 'RRULE:FREQ=WEEKLY;UNTIL=' + untilDate + ';WKST=SU;BYDAY=' + days;

    var event = {
      summary: classNames[i],
      location: location[i],
      description: "Events addeed by UCR to Google Calender web app.",
      start: {
        dateTime: startDate,
        timeZone: 'America/Los_Angeles'
      },
      end: {
        dateTime: endDate,
        timeZone: 'America/Los_Angeles'
      },
      recurrence: [recurrence],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 10 }
        ]
      }
    };

    calendar.events.insert({
        auth: auth,
        calendarId: 'primary',
        resource: event
      },
      function(err, event) {
        if (err) return console.log('The API returned an error: ' + err);
        console.log('Event created: %s', event.htmlLink);
      });
  }
}

app.get('/', async function(req, res) {
  res.render('app.ejs');
});

app.post('/auth', function(req, res) {
  fs.readFile('credentials.json', (err, content) => {
    if (err) return console.log('Error loading client secret file:', err);
    const {client_secret, client_id, redirect_uris} = JSON.parse(content).installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[1]);
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });

    req.session.schedule = req.body.schedule;
    req.app.locals.client = oAuth2Client;
    req.session.url = authUrl;

    //queue.push({key: oAuth2Client, val: req.body.schedule});
    res.json(authUrl);
  });
});

app.get('/done', function(req, res) {
  var code = req.query.code;
  var auth = req.app.locals.client;
  auth.getToken(code, (err, token) => {
    if (err) return console.error('Error retrieving access token', err);
    auth.setCredentials(token);
    //listEvents(auth);
    getEventsFromString(req.session.schedule, auth);
  });
  res.render('done.ejs');
});

app.listen(3000, () => console.log(`Listening on port 3000!`));
