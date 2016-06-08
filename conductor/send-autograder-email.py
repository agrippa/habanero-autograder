#!/usr/bin/python
import os
import sys
import smtplib

# Helper script for sending an e-mail from the autograder e-mail account.

def send_email(user, pwd, recipient, subject, body):
    gmail_user = user
    gmail_pwd = pwd
    FROM = user
    TO = recipient if type(recipient) is list else [recipient]
    SUBJECT = subject
    TEXT = body

    # Prepare actual message
    message = """\From: %s\nTo: %s\nSubject: %s\n\n%s
    """ % (FROM, ", ".join(TO), SUBJECT, TEXT)
    try:
        server = smtplib.SMTP("smtp.gmail.com", 587)
        server.ehlo()
        server.starttls()
        server.login(gmail_user, gmail_pwd)
        server.sendmail(FROM, TO, message)
        server.close()
        print 'successfully sent the mail'
    except:
        print "failed to send mail"

if len(sys.argv) != 4:
    print('usage: python send-autograder-email.py recipient subject body')
    sys.exit(1)

send_email(os.environ['GMAIL_USER'], os.environ['GMAIL_PASS'], sys.argv[1], sys.argv[2], sys.argv[3])
