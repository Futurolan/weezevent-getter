
GET from backoffice the list of edition with "Craw Weezevent Field active"
 FOREACH EDITION
    GET from backoffice the list of tournament
        FOREACH tournament
            GET from weezevent
                IF MD5 of the data != previews MD5
                    DO THE STUFF & PUT on backoffice the data for the tournament -> SET MD5 of the Data
                    Wait 5 minutes !!!
